import type { Writable } from '../base';
import type { ThemeColorTable } from '../shiki';
import type { Git } from './git';

import { disposableStore, type DisposableType, type IDisposable } from '@wopjs/disposable';

export interface IMain {
  readonly git: Git;
  setTitle(title: string): void;
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
