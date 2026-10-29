import type { Disposer } from '@wopjs/disposable';
import type { CommitShortStat } from '../common/git';

import flru from 'flru';
import { noop } from '@wopjs/cast';

interface StatRequest {
  readonly hash: string;
  readonly controller: AbortController;
  readonly listeners: Set<(stat: CommitShortStat) => void>;
  running: boolean;
}

/** Only visible commits retain queued or running requests. */
export class CommitStats {
  private readonly cache = flru<CommitShortStat>(200);
  private readonly pending = new Map<string, StatRequest>();
  private running = 0;
  private scheduled = false;
  private disposed = false;

  constructor(private readonly read: (hash: string, signal: AbortSignal) => Promise<CommitShortStat>) { }

  subscribe(hash: string, listener: (stat: CommitShortStat) => void): Disposer {
    if (this.disposed) return noop;
    const cached = this.cache.get(hash);
    if (cached) {
      listener(cached);
      return noop;
    }
    let request = this.pending.get(hash);
    if (!request) {
      request = { hash, controller: new AbortController(), listeners: new Set(), running: false };
      this.pending.set(hash, request);
    }
    request.listeners.add(listener);
    this.schedule();
    return () => {
      request.listeners.delete(listener);
      if (!request.listeners.size && this.pending.get(hash) === request) {
        this.pending.delete(hash);
        request.controller.abort();
      }
    };
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    // Coalesce row creation and disposal during the same render.
    queueMicrotask(() => {
      this.scheduled = false;
      for (const request of this.pending.values()) {
        if (this.running >= 2) break;
        if (!request.running) void this.load(request);
      }
    });
  }

  private async load(request: StatRequest): Promise<void> {
    request.running = true;
    this.running++;
    const signal = request.controller.signal;
    try {
      const stat = await this.read(request.hash, signal);
      if (signal.aborted) return;
      this.cache.set(request.hash, stat);
      for (const listener of request.listeners) listener(stat);
    } catch (error) {
      if (!signal.aborted) console.error(error);
    } finally {
      if (this.pending.get(request.hash) === request) this.pending.delete(request.hash);
      this.running--;
      this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const request of this.pending.values()) {
      request.listeners.clear();
      request.controller.abort();
    }
    this.pending.clear();
    this.cache.clear(false);
  }
}
