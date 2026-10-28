import type { Diff, DiffFile, DiffRange, IBasicGitInfo, LsTreeElement, Ref, Snapshot } from '../common/git';

import flru from 'flru';
import { noop } from '@wopjs/cast';
import { seq } from '@wopjs/async-seq';
import { disposableStore, type IDisposable } from '@wopjs/disposable';
import { arrayShallowEqual, combine, derive, reactiveArray, writable, type Readable, type Writable } from '@embra/reactivity';
import { STEP, type Writable as Mutable } from '../common/base';
import { Tree, type TreeNode } from '../common/tree';

export class Git implements IDisposable {
  private readonly _store = disposableStore();

  readonly repo: string;
  readonly refs: Ref[];
  readonly head: Ref;
  readonly history = this._store.add(reactiveArray<Snapshot | undefined>());
  private readonly offset: number;

  readonly index$ = this._store.add(writable(0));
  readonly snapshot$: Readable<Snapshot | undefined>;
  readonly tree$: Writable<Tree<LsTreeElement> | undefined>;
  readonly fileList$: Readable<TreeNode<LsTreeElement>[]>;
  readonly error$ = this._store.add(writable<string | undefined>(undefined));

  private readonly cache = flru<Promise<Uint8Array>>(20);
  private readonly diffs = flru<Promise<Diff>>(20);
  private treeSnapshot: Snapshot | undefined;

  private constructor(info: IBasicGitInfo) {
    this._store.add(this.index$.subscribe(() => this.navigation++));
    this.repo = info.root;
    this.refs = info.refs;
    this.head = info.head;
    this.offset = info.workingTree ? 1 : 0;
    this.history.replace(info.workingTree ? [info.workingTree, ...info.commits] : info.commits);
    this.history.setLength(info.total + this.offset);
    this.snapshot$ = this._store.add(combine([this.index$, this.history.$], (index, history) => history[index]));

    const queue = this._store.add(seq({ dropHead: true, window: 1 }));
    const tree$ = this._store.add(writable<Tree<LsTreeElement> | undefined>(undefined));
    this.tree$ = tree$;
    this._store.add(this.snapshot$.subscribe(snapshot => {
      this.cache.clear(false);
      this.error$.set(undefined);
      if (snapshot) {
        queue.schedule(async () => {
          try {
            const tree = await _api<Tree<LsTreeElement>>('/tree', _query(snapshot));
            if (!tree$.disposed && this.snapshot$.value === snapshot) {
              this.treeSnapshot = snapshot;
              _migrate(tree$, tree);
            }
          } catch (error) {
            if (!tree$.disposed && this.snapshot$.value === snapshot) {
              tree$.set(undefined);
              this.error$.set(String(error));
            }
          }
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
    _parseDates(info);
    return new Git(info);
  }

  toggle(path: string): void {
    const tree = this.tree$.value;
    if (tree) {
      const newTree = Tree.toggle(tree, node => 'data' in node && node.data.file === path);
      this.tree$.set(newTree);
    }
  }

  private readonly _fetching: { [group: number]: Promise<void>; } = [Promise.resolve()];
  private _touching = 1;
  touch(end: number): Promise<void> {
    const max = Math.max(0, Math.floor((Math.min(end, this.history.length) - this.offset - 1) / STEP));
    while (this._touching <= max) {
      this._fetching[this._touching] = this._fetch(this._touching);
      this._touching++;
    }
    return this._fetching[max];
  }

  private navigation = 0;

  async goto(refName: string): Promise<void> {
    const navigation = ++this.navigation;
    const ref = this.refs.find(ref => ref.name === refName);
    if (!ref?.commit) return;
    for (let i = this.offset; i < this.history.length; i++) {
      if (this.history[i] == null) await this.touch(i + 1);
      if (navigation !== this.navigation) return;
      const snapshot = this.history[i];
      if (snapshot?.kind === 'commit' && snapshot.hash === ref.commit) {
        this.index$.set(i);
        window.dispatchEvent(new CustomEvent('scroll-to', { detail: i }));
        return;
      }
    }
  }

  blob(path: string, snapshot: Snapshot): Promise<Uint8Array> {
    const key = `${snapshot.kind === 'commit' ? snapshot.hash : 'working-tree'}:${path}`;
    let p = this.cache.get(key);
    if (!p) {
      p = _blob('/show', { ..._query(snapshot), path });
      this.cache.set(key, p);
    }
    return p;
  }

  async paths(snapshot: Snapshot): Promise<string[]> {
    const tree = this.treeSnapshot === snapshot && this.tree$.value
      ? this.tree$.value : await _api<Tree<LsTreeElement>>('/tree', _query(snapshot));
    const paths: string[] = [];
    Tree.dfs(tree, node => {
      if (node.data.type === 'blob') paths.push(node.data.file);
    });
    return paths;
  }

  prefetch(path: string): void {
    const snapshot = this.snapshot$.value;
    if (snapshot) this.blob(path, snapshot).catch(noop);
  }

  diff(snapshot: Snapshot): Promise<Diff> {
    if (snapshot.kind === 'working-tree') return _api('/diff', _query(snapshot));
    let result = this.diffs.get(snapshot.hash);
    if (!result) {
      result = _api<Diff>('/diff', _query(snapshot));
      this.diffs.set(snapshot.hash, result);
      result.catch(() => this.diffs.clear(false));
    }
    return result;
  }

  async diffContents(range: DiffRange, file: DiffFile): Promise<[Uint8Array, Uint8Array]> {
    return Promise.all([
      file.status === 'A' ? new Uint8Array() : _blob('/show', { ref: range.base, path: file.oldPath }),
      file.status === 'D' ? new Uint8Array() : _blob('/show', {
        ...(range.target ? { ref: range.target } : { workingTree: '1' }), path: file.newPath,
      }),
    ]);
  }

  private async _fetch(group: number): Promise<void> {
    const info = await _api<IBasicGitInfo>('/log', { skip: group * STEP });
    _parseDates(info);
    this.history.splice(group * STEP + this.offset, info.commits.length, ...info.commits);
  }
}

function _query(snapshot: Snapshot): Record<string, string> {
  return snapshot.kind === 'commit' ? { ref: snapshot.hash } : { workingTree: '1' };
}

function _parseDates(info: IBasicGitInfo): void {
  for (const commit of info.commits) {
    if (commit.authorDate) (commit as Mutable<typeof commit>).authorDate = new Date(commit.authorDate);
    if (commit.commitDate) (commit as Mutable<typeof commit>).commitDate = new Date(commit.commitDate);
  }
}

function _migrate(tree$: Writable<Tree<LsTreeElement> | undefined>, tree: Tree<LsTreeElement>) {
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
      (node as Mutable<TreeNode<LsTreeElement>>).collapsed = false;
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
