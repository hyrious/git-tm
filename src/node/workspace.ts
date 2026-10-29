import type { FileContents, FileReference, SymbolQuery, SymbolResults } from '../common/symbols';

import { Worker } from 'node:worker_threads';
import { FileSource, SymbolAction } from '../common/symbols';

export const enum WorkspaceRequestKind {
  File,
  Symbols,
}

export type WorkspaceRequest =
  | { readonly kind: WorkspaceRequestKind.File; readonly ref: string | undefined; readonly file: FileReference; }
  | { readonly kind: WorkspaceRequestKind.Symbols; readonly ref: string | undefined; readonly query: SymbolQuery; };

export interface WorkspaceMessage {
  readonly id: number;
  readonly request: WorkspaceRequest;
}

export interface WorkspaceResponse {
  readonly id: number;
  result: FileContents | SymbolResults | undefined;
  error: string | undefined;
}

interface PendingRequest {
  resolve(value: FileContents | SymbolResults): void;
  reject(error: Error): void;
  dispose(): void;
}

/** File reads and syntax queries stay responsive while semantic indexing runs. */
export class Workspace {
  private readonly files: WorkspaceWorker;
  private readonly semantic: WorkspaceWorker;

  constructor(root: string) {
    this.files = new WorkspaceWorker(root);
    this.semantic = new WorkspaceWorker(root);
  }

  file(ref: string | undefined, file: FileReference): Promise<FileContents> {
    // External files must have been discovered by the language service.
    const worker = file.source === FileSource.External ? this.semantic : this.files;
    return worker.request({ kind: WorkspaceRequestKind.File, ref, file }) as Promise<FileContents>;
  }

  symbols(ref: string | undefined, query: SymbolQuery, signal?: AbortSignal): Promise<SymbolResults> {
    const local = query.action === SymbolAction.FileSymbols && query.file?.source === FileSource.Snapshot;
    const worker = local ? this.files : this.semantic;
    return worker.request({ kind: WorkspaceRequestKind.Symbols, ref, query }, signal) as Promise<SymbolResults>;
  }

  dispose(): void {
    this.files.dispose();
    this.semantic.dispose();
  }
}

class WorkspaceWorker {
  private readonly pending = new Map<number, PendingRequest>();

  private worker: Worker | undefined;
  private nextId = 0;
  private disposed = false;

  constructor(private readonly root: string) { }

  request(request: WorkspaceRequest, signal?: AbortSignal): Promise<FileContents | SymbolResults> {
    if (this.disposed) return Promise.reject(new Error('Workspace closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.worker) {
      const worker = this.worker = new Worker(new URL('./workspace-worker.js', import.meta.url), { workerData: this.root });
      worker.on('message', ({ id, result, error }: WorkspaceResponse) => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.dispose();
        if (error != null) pending?.reject(new Error(error));
        else if (result) pending?.resolve(result);
      });
      worker.on('error', error => {
        if (this.worker === worker) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
          this.stop();
        }
      });
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.fail(new Error('Workspace worker exited'));
        }
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () => {
        this.pending.delete(id);
        reject(signal!.reason);
        // Preserve other clients' requests, but stop abandoned CPU-bound work.
        if (!this.pending.size) this.stop();
      };
      const dispose = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, reject, dispose });
      signal?.addEventListener('abort', abort, { once: true });
      const message: WorkspaceMessage = { id, request };
      this.worker!.postMessage(message);
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.dispose();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stop(): void {
    void this.worker?.terminate();
    this.worker = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.fail(new Error('Workspace closed'));
    this.stop();
  }
}
