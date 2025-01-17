import type { IDisposable } from '@wopjs/disposable';

export class Pool<Resource> implements IDisposable {

  private readonly _resources: Resource[] = [];

  constructor(private readonly _alloc: () => Resource) { }

  alloc(): Resource {
    return this._resources.pop() || this._alloc();
  }

  release(resource: Resource): void {
    this._resources.push(resource);
  }

  dispose() {
    this._resources.length = 0;
  }
}
