import type { Writable } from '../common/base';
import type { Git } from './git';
import type { Files } from './files';
import type { Status } from './status';
import type { Editor } from './editor';
import type { Commits } from './commits';

import { disposableStore, type DisposableType, type IDisposable } from '@wopjs/disposable';

export interface IMain {
  readonly git: Git;
  readonly files: Files;
  readonly editor: Editor;
  readonly status: Status;
  readonly commits: Commits;
  setTitle(filename?: string): void;
}

export abstract class Widget implements IDisposable {
  private readonly _store = disposableStore();
  _register<T extends DisposableType>(disposable: T) {
    return this._store.add(disposable);
  }

  dispose() { this._store.dispose(); }

  constructor(readonly parent: HTMLElement, readonly root: IMain) {
    queueMicrotask(() => this.initialize());
  }

  abstract initialize(this: Writable<this>): void;
  abstract layout(): void;
}
