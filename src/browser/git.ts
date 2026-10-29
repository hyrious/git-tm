import type { FileContents, FileReference, SymbolQuery, SymbolResults } from '../common/symbols';
import type { Disposer } from '@wopjs/disposable';
import type { Commit, CommitShortStat, Diff, DiffFile, DiffRange, IBasicGitInfo, LsTreeElement, Ref, Revision, Snapshot, WorkingTree } from '../common/git';

import flru from 'flru';
import { seq } from '@wopjs/async-seq';
import { arrayShallowEqual, combine, derive, reactiveArray, writable, type Readable, type Writable } from '@embra/reactivity';
import { STEP, type Writable as Mutable } from '../common/base';
import { Disposable } from '../common/disposable';
import { SnapshotKind, snapshotId } from '../common/git';
import { FileSource } from '../common/symbols';
import { Tree, type TreeNode } from '../common/tree';
import { CommitStats } from './commit-stats';

export class Git extends Disposable {

  readonly repo: string;
  readonly refs: Ref[];
  readonly head: Ref;
  readonly history = this._register(reactiveArray<Snapshot | undefined>());

  readonly index$ = this._register(writable(0));
  readonly snapshot$: Readable<Snapshot | undefined>;
  readonly tree$: Writable<Tree<LsTreeElement> | undefined>;
  readonly fileList$: Readable<TreeNode<LsTreeElement>[]>;
  readonly error$ = this._register(writable<string | undefined>(undefined));

  private readonly offset: number;
  private readonly fetching: { [group: number]: Promise<void>; } = [Promise.resolve()];
  private readonly cache = flru<Promise<FileContents>>(20);
  private readonly diffs = flru<Promise<Diff>>(20);
  private readonly revisions = flru<Promise<Revision>>(20);
  private readonly stats = this._register(new CommitStats((ref, signal) => _api('/stat', { ref }, signal)));

  private touching = 1;
  private navigation = 0;
  private treeSnapshot: Snapshot | undefined;

  private constructor(info: IBasicGitInfo) {
    super();
    this._register(this.index$.subscribe(() => this.navigation++));
    this.repo = info.root;
    this.refs = info.refs;
    this.head = info.head;
    this.offset = info.workingTree ? 1 : 0;
    this.history.replace(info.workingTree ? [info.workingTree, ...info.commits] : info.commits);
    this.history.setLength(info.total + this.offset);
    this.snapshot$ = this._register(combine([this.index$, this.history.$], (index, history) => history[index]));

    const queue = this._register(seq({ dropHead: true, window: 1 }));
    const tree$ = this._register(writable<Tree<LsTreeElement> | undefined>(undefined));
    this.tree$ = tree$;
    this._register(this.snapshot$.subscribe(snapshot => {
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

    this.fileList$ = this._register(derive(tree$, tree => tree ? Tree.flat(tree) : [], { equal: arrayShallowEqual }));
  }

  static async init(): Promise<Git> {
    const info = await _api<IBasicGitInfo>('/log');
    _parseDates(info);
    return new Git(info);
  }

  toggle(path: string): void {
    const tree = this.tree$.value;
    if (tree) {
      const newTree = Tree.toggle(tree, node => node.data.file === path);
      this.tree$.set(newTree);
    }
  }

  expand(path: string): void {
    const tree = this.tree$.value;
    if (tree) {
      this.tree$.set(Tree.toggle(tree, node => node.collapsible && node.collapsed && path.startsWith(node.data.file + '/')));
    }
  }

  touch(end: number): Promise<void> {
    const max = Math.max(0, Math.floor((Math.min(end, this.history.length) - this.offset - 1) / STEP));
    while (this.touching <= max) {
      this.fetching[this.touching] = this._fetch(this.touching);
      this.touching++;
    }
    return this.fetching[max];
  }

  async goto(refName: string): Promise<void> {
    const navigation = ++this.navigation;
    const ref = this.refs.find(ref => ref.name === refName);
    if (!ref?.commit) return;
    for (let i = this.offset; i < this.history.length; i++) {
      if (this.history[i] == null) await this.touch(i + 1);
      if (navigation !== this.navigation) return;
      const snapshot = this.history[i];
      if (snapshot?.kind === SnapshotKind.Commit && snapshot.hash === ref.commit) {
        this.index$.set(i);
        window.dispatchEvent(new CustomEvent('scroll-to', { detail: i }));
        return;
      }
    }
  }

  resolveRevision(ref: string): Promise<Revision> {
    let result = this.revisions.get(ref);
    if (!result) {
      result = _api<Revision>('/revision', { ref });
      this.revisions.set(ref, result);
      result.catch(() => this.revisions.clear(false));
    }
    return result;
  }

  async findSnapshot(id: string): Promise<number | undefined> {
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i] == null) await this.touch(i + 1);
      const snapshot = this.history[i];
      if (snapshot && snapshotId(snapshot) === id) return i;
      if (id === 'working-tree') return;
    }
  }

  contents(file: FileReference, snapshot: Snapshot): Promise<FileContents> {
    const query = { ..._query(snapshot), path: file.path, source: file.source };
    if (snapshot.kind === SnapshotKind.WorkingTree || file.source === FileSource.External) return _contents(query);
    const key = `${snapshot.hash}:${file.path}`;
    let result = this.cache.get(key);
    if (!result) {
      result = _contents(query);
      this.cache.set(key, result);
      result.catch(() => this.cache.clear(false));
    }
    return result;
  }

  symbols(snapshot: Snapshot, query: SymbolQuery, signal?: AbortSignal): Promise<SymbolResults> {
    return _api('/symbols', {
      ..._query(snapshot), action: query.action,
      path: query.file?.path ?? '', source: query.file?.source ?? FileSource.Snapshot,
      version: query.version ?? '', position: query.position ?? 0,
    }, signal);
  }

  blob(path: string, snapshot: Snapshot): Promise<Uint8Array> {
    return this.contents({ source: FileSource.Snapshot, path }, snapshot).then(file => file.bytes);
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

  diff(snapshot: Snapshot): Promise<Diff> {
    if (snapshot.kind === SnapshotKind.WorkingTree) return _api('/diff', _query(snapshot));
    let result = this.diffs.get(snapshot.hash);
    if (!result) {
      result = _api<Diff>('/diff', _query(snapshot));
      this.diffs.set(snapshot.hash, result);
      result.catch(() => this.diffs.clear(false));
    }
    return result;
  }

  shortStat(commit: Commit, listener: (stat: CommitShortStat) => void): Disposer {
    return this.stats.subscribe(commit.hash, listener);
  }

  async diffContents(range: DiffRange, file: DiffFile): Promise<[Uint8Array, Uint8Array]> {
    const base = { ref: range.base, path: file.oldPath };
    const revision: Record<string, string> = range.target ? { ref: range.target } : { workingTree: '1' };
    const target = { ...revision, path: file.newPath };
    return Promise.all([
      file.status === 'A' ? new Uint8Array() : _contents(base).then(file => file.bytes),
      file.status === 'D' ? new Uint8Array() : _contents(target).then(file => file.bytes),
    ]);
  }

  private async _fetch(group: number): Promise<void> {
    const info = await _api<IBasicGitInfo>('/log', { skip: group * STEP });
    _parseDates(info);
    this.history.splice(group * STEP + this.offset, info.commits.length, ...info.commits);
  }
}

function _query(snapshot: Snapshot): Record<string, string> {
  return snapshot.kind === SnapshotKind.Commit ? { ref: snapshot.hash } : { workingTree: '1' };
}

function _parseDates(info: IBasicGitInfo): void {
  if (info.workingTree) {
    (info.workingTree as Mutable<WorkingTree>).date = new Date(info.workingTree.date);
  }
  for (const commit of info.commits) {
    if (commit.authorDate) (commit as Mutable<Commit>).authorDate = new Date(commit.authorDate);
    if (commit.commitDate) (commit as Mutable<Commit>).commitDate = new Date(commit.commitDate);
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
      (node as Mutable<TreeNode<unknown>>).collapsed = false;
    }
  });

  tree$.value = tree;
}

async function _api<T>(path: string, query: Record<string, string | number> = {}, signal?: AbortSignal): Promise<T> {
  const response = await _request(path, query, signal);
  return response.json();
}

async function _request(path: string, query: Record<string, string | number>, signal?: AbortSignal): Promise<Response> {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(await response.text());
  return response;
}

async function _contents(query: Record<string, string | number>): Promise<FileContents> {
  const response = await _request('/show', query);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    version: response.headers.get('X-File-Version') ?? '',
  };
}
