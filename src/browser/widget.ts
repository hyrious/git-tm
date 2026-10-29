import type { Writable } from '../common/base';
import type { Git } from './git';
import type { Files } from './files';
import type { Status } from './status';
import type { Editor } from './editor';
import type { Commits } from './commits';
import type { SnapshotIndex } from './symbol-index';

import { Disposable } from '../common/disposable';

export interface IMain {
  readonly git: Git;
  readonly files: Files;
  readonly editor: Editor;
  readonly status: Status;
  readonly commits: Commits;
  readonly symbolIndex: SnapshotIndex;
  setTitle(filename?: string): void;
}

export abstract class Widget extends Disposable {
  constructor(readonly parent: HTMLElement, readonly root: IMain) {
    super();
    queueMicrotask(() => this.initialize());
  }

  abstract initialize(this: Writable<this>): void;
  abstract layout(): void;
}
