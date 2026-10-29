import { disposableStore, type DisposableType, type IDisposable } from '@wopjs/disposable';

export class Disposable implements IDisposable {
  private readonly _store = disposableStore();

  _register<T extends DisposableType>(disposable: T) {
    return this._store.add(disposable);
  }

  dispose(): void {
    this._store.dispose();
  }
}
