import type { Commit, IBasicGitInfo, LsTreeElement, Ref } from '../repository';

import flru from 'flru';
import { seq } from '@wopjs/async-seq';
import { isDefined } from '@wopjs/cast';
import { reactiveList } from 'value-enhancer/collections';
import { disposableStore, type IDisposable } from '@wopjs/disposable';
import { arrayShallowEqual, combine, derive, setValue, subscribe, val, type ReadonlyVal, type Val } from 'value-enhancer';
import { STEP, type Writable } from '../base';
import { Tree, type TreeNode } from './tree';

export class Git implements IDisposable {
  private readonly _store = disposableStore();

  readonly repo: string;
  readonly refs: Ref[];
  readonly commits = this._store.add(reactiveList<Commit | undefined>());

  readonly index$ = this._store.add(val(0));
  readonly commit$: ReadonlyVal<Commit | undefined>;
  readonly tree$: ReadonlyVal<Tree<LsTreeElement> | undefined>;
  readonly fileList$: ReadonlyVal<TreeNode<LsTreeElement>[]>;

  private readonly cache = flru<Promise<Uint8Array | undefined>>(20);
  private readonly codeCache = flru<Promise<string | undefined>>(20);

  private constructor(info: IBasicGitInfo) {
    this.repo = info.root;
    this.refs = info.refs;
    this.commits = this._store.add(reactiveList(info.commits));
    this.commits.setLength(info.total);

    this.commit$ = this._store.add(combine([this.index$, this.commits.$], ([index, commits]) => commits[index]));

    const queue = this._store.add(seq({ dropHead: true, window: 1 }));
    const tree$ = this.tree$ = this._store.add(val<Tree<LsTreeElement> | undefined>());
    this._store.add(subscribe(this.commit$, commit => {
      if (commit) {
        this.cache.clear(false);
        this.codeCache.clear(false);
        queue.schedule(async () => {
          _migrate(tree$, await _api<Tree<LsTreeElement>>('/tree', { ref: commit.hash }));
        });
      }
    }));

    this.fileList$ = this._store.add(derive(tree$, tree => tree ? Tree.flat(tree) : [], { equal: arrayShallowEqual }));
  }

  dispose() {
    this._store.dispose();
  }

  static async init(): Promise<Git> {
    const info = await _api<IBasicGitInfo>('/log');
    for (const e of info.commits) {
      if (e.authorDate) (e as any).authorDate = new Date(e.authorDate);
      if (e.commitDate) (e as any).commitDate = new Date(e.commitDate);
    }
    return new Git(info);
  }

  toggle(path: string): void {
    const tree = this.tree$.value;
    if (tree) {
      const newTree = Tree.toggle(tree, node => 'data' in node && node.data.file === path);
      setValue(this.tree$, newTree);
    }
  }

  private readonly _fetching: { [group: number]: Promise<void>; } = [Promise.resolve()];
  private _touching = 1;
  touch(end: number): Promise<void> {
    const max = Math.ceil(end / STEP);
    while (this._touching <= max) {
      this._fetching[this._touching] = this._fetch(this._touching);
      this._touching++;
    }
    return this._fetching[max];
  }

  async goto(refName: string): Promise<void> {
    for (let i = 0; i < this.commits.length; i++) {
      if (this.commits.get(i) == null) {
        await this.touch(i);
      }
      const refNames = this.commits.get(i)!.refNames;
      if (refNames.includes(refName) || refNames.includes('HEAD -> ' + refName)) {
        setValue(this.index$, i);
        window.dispatchEvent(new CustomEvent('scroll-to', { detail: i }));
        return;
      }
    }
  }

  async blob(path: string): Promise<Uint8Array | undefined> {
    const commit = await _wait$(this.commit$);
    let p: Promise<Uint8Array | undefined> | undefined;
    if (p = this.cache.get(path)) return p;
    p = _blob('/show', { ref: commit.hash, path }).catch((error) => void console.log(error + ''));
    this.cache.set(path, p);
    return p;
  }

  async render(path: string): Promise<string | undefined> {
    const commit = await _wait$(this.commit$);
    let p: Promise<string | undefined> | undefined;
    if (p = this.codeCache.get(path)) return p;
    p = _text('/code', { ref: commit.hash, path }).catch((error) => void console.log(error + ''));
    this.codeCache.set(path, p);
    return p;
  }

  prefetch(path: string): void {
    const commit = this.commit$.value;
    if (!commit || this.cache.has(path)) return;
    this.cache.set(path, _blob('/show', { ref: commit.hash, path }));
  }

  private async _fetch(group: number): Promise<void> {
    const info = await _api<IBasicGitInfo>('/log', { skip: group * STEP });
    for (const e of info.commits) {
      if (e.authorDate) (e as any).authorDate = new Date(e.authorDate);
      if (e.commitDate) (e as any).commitDate = new Date(e.commitDate);
    }
    this.commits.splice(group * STEP, info.commits.length, ...info.commits);
  }
}

function _migrate(tree$: Val<Tree<LsTreeElement> | undefined>, tree: Tree<LsTreeElement>) {
  const ref = tree$.value;
  if (!ref) {
    tree$.value = tree;
    return;
  }

  const expanded = new Set<string>();
  Tree.dfs(ref, node => {
    if (node.collapsible && !node.collapsed) {
      expanded.add(node.data.file);
    }
  });

  Tree.dfs(tree, node => {
    if (node.collapsible && expanded.has(node.data.file)) {
      (node as Writable<TreeNode<LsTreeElement>>).collapsed = false;
    }
  });

  tree$.value = tree;
}

async function _api<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(path, location.origin);
  for (const key in query) {
    url.searchParams.set(key, query[key].toString());
  }
  const r = await fetch(url.href);
  if (r.ok) {
    return r.json();
  }
  throw new Error(await r.text());
}

async function _text(path: string, query: Record<string, string | number> = {}): Promise<string> {
  const url = new URL(path, location.origin);
  for (const key in query) {
    url.searchParams.set(key, query[key].toString());
  }
  const r = await fetch(url.href);
  if (r.ok) {
    return r.text();
  }
  throw new Error(await r.text());
}

async function _blob(path: string, query: Record<string, string | number> = {}): Promise<Uint8Array> {
  const url = new URL(path, location.origin);
  for (const key in query) {
    url.searchParams.set(key, query[key].toString());
  }
  const r = await fetch(url.href);
  if (r.ok) {
    return r.arrayBuffer().then(a => new Uint8Array(a));
  }
  throw new Error(await r.text());
}

function _wait$<T>(val: ReadonlyVal<T | undefined>): Promise<T> {
  if (isDefined(val.value)) return Promise.resolve(val.value);
  return new Promise<T>(resolve => {
    const dispose = subscribe(val, v => {
      if (isDefined(v)) {
        resolve(v);
        dispose();
      }
    });
  });
}
