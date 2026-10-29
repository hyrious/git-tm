import type { FileContents, FileReference, SymbolQuery, SymbolResults } from '../common/symbols';

import { Worker } from 'node:worker_threads';

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
}

/** One worker owns the file versions and lazily loads TypeScript. */
export class Workspace {
  private readonly pending = new Map<number, PendingRequest>();

  private worker: Worker | undefined;
  private nextId = 0;

  constructor(private readonly root: string) { }

  file(ref: string | undefined, file: FileReference): Promise<FileContents> {
    return this.request({ kind: WorkspaceRequestKind.File, ref, file }) as Promise<FileContents>;
  }

  symbols(ref: string | undefined, query: SymbolQuery): Promise<SymbolResults> {
    return this.request({ kind: WorkspaceRequestKind.Symbols, ref, query }) as Promise<SymbolResults>;
  }

  private request(request: WorkspaceRequest): Promise<FileContents | SymbolResults> {
    if (!this.worker) {
      const worker = this.worker = new Worker(new URL('./workspace-worker.js', import.meta.url), { workerData: this.root });
      worker.on('message', ({ id, result, error }: WorkspaceResponse) => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (error != null) pending?.reject(new Error(error));
        else if (result) pending?.resolve(result);
      });
      worker.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))));
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.fail(new Error('Workspace worker exited'));
        }
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      const message: WorkspaceMessage = { id, request };
      this.worker!.postMessage(message);
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  dispose(): void {
    this.fail(new Error('Workspace closed'));
    void this.worker?.terminate();
    this.worker = undefined;
  }
}
