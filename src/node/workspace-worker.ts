import type { WorkspaceMessage, WorkspaceResponse } from './workspace';
import type { Symbols } from './symbols';

import { parentPort, workerData } from 'node:worker_threads';
import { WorkspaceRequestKind } from './workspace';
import { Repository } from './repository';
import { FileSource } from '../common/symbols';
import { SnapshotFiles } from './snapshot-files';

const files = new SnapshotFiles(new Repository(workerData));
let symbols: Symbols | undefined;
let queue = Promise.resolve();

parentPort!.on('message', (message: WorkspaceMessage) => {
  queue = queue.then(async () => {
    const response: WorkspaceResponse = { id: message.id, result: undefined, error: undefined };
    try {
      const request = message.request;
      const refresh = request.kind === WorkspaceRequestKind.Symbols
        || request.file.source === FileSource.Snapshot && !files.entries.has(files.absolute(request.file.path));
      await files.select(request.ref, refresh);
      if (request.kind === WorkspaceRequestKind.File) {
        response.result = files.contents(request.file);
      } else {
        symbols ??= new (await import('./symbols.js')).Symbols(files);
        response.result = symbols.query(request.query);
      }
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    parentPort!.postMessage(response);
  });
});
