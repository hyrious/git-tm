// Source taken from VS Code's builtin Git extension.

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Disposer } from '@wopjs/disposable';
import type { Tree, TreeNode } from './browser/tree';

import cp from 'node:child_process';
import { isTruthy } from '@wopjs/cast';
import { STEP, type Writable } from './base';

export interface LogOptions {
  readonly skip?: number;
  /** Default {@link STEP}. */
  readonly limit?: number | { readonly id: string; };
  readonly shortStats?: boolean;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
  readonly refNames: string[];
  readonly shortStat?: CommitShortStat;
}

export interface CommitShortStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface ExecResult<T extends string | Uint8Array> {
  exitCode: number;
  stdout: T;
  stderr: string;
}

export const enum RefType {
  Head,
  RemoteHead,
  Tag,
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface LsTreeElement {
  /** For example, `100644`. */
  readonly mode: string;
  readonly type: 'commit' | 'blob' | 'tree';
  readonly object: string;
  /** Bytes, folders will be `-`. */
  readonly size: string;
  readonly file: string;
}

export interface LsTreeOptions {
  readonly path?: string;
  readonly recursive?: boolean;
}

export interface IBasicGitInfo {
  root: string;
  refs: Ref[];
  commits: Commit[];
  total: number;
}

const COMMIT_FORMAT = '%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B';

export class Repository {
  constructor(readonly root: string) { }

  async lstree(treeish: string, options?: LsTreeOptions): Promise<LsTreeElement[]> {
    const args = ['-c', 'core.quotePath=false', 'ls-tree', '-l', treeish];
    if (options?.recursive) {
      args.push('-r');
    }
    if (options?.path) {
      args.push('--', options.path);
    }
    const result = await this.exec(args);
    return parseLsTree(result.stdout);
  }

  async buffer(ref: string, path: string): Promise<Buffer> {
    const object = `${ref}:${path}`;
    const result = await this.exec(['show', '--textconv', object], true);
    if (result.exitCode) {
      return Promise.reject<Buffer>(new Error('Could not show object'));
    }
    return result.stdout;
  }

  async getRefs(): Promise<Ref[]> {
    const args = ['for-each-ref', '--format', '%(refname) %(objectname) %(*objectname)'];
    const result = await this.exec(args);
    const refs: Ref[] = [];

    let match: RegExpExecArray | null;
    for (const line of result.stdout.split('\n')) {
      if (line) {
        if (match = /^refs\/heads\/([^ ]+) ([0-9a-f]{40}) ([0-9a-f]{40})?$/.exec(line)) {
          refs.push({ name: match[1], commit: match[2], type: RefType.Head });
        } else if (match = /^refs\/remotes\/([^/]+)\/([^ ]+) ([0-9a-f]{40}) ([0-9a-f]{40})?$/.exec(line)) {
          refs.push({ name: `${match[1]}/${match[2]}`, commit: match[3], type: RefType.RemoteHead, remote: match[1] });
        } else if (match = /^refs\/tags\/([^ ]+) ([0-9a-f]{40}) ([0-9a-f]{40})?$/.exec(line)) {
          refs.push({ name: match[1], commit: match[3] ?? match[2], type: RefType.Tag });
        }
      }
    }

    return refs;
  }

  async log(options?: LogOptions): Promise<Commit[]> {
    const args = ['log', `--format=${COMMIT_FORMAT}`, '--all', '-z'];

    if (!options?.limit || typeof options.limit === 'number') {
      args.push(`-n${options?.limit ?? STEP}`);
    } else if (typeof options.limit.id === 'string') {
      const commit = await this.getCommit(options.limit.id);
      const parent = commit.parents[0] ?? await this.getEmptyTree();
      args.push(`${parent}..`);
    }

    if (typeof options?.skip === 'number') {
      args.push(`--skip=${options.skip}`);
    }

    if (options?.shortStats) {
      args.push('--shortstat');
    }

    const result = await this.exec(args);
    if (result.exitCode) {
      return [];
    }

    return parseGitCommits(result.stdout);
  }

  async logSize(): Promise<number> {
    const args = ['rev-list', '--all', '--count'];

    const result = await this.exec(args);
    if (result.exitCode) {
      return 0;
    }

    return Number.parseInt(result.stdout);
  }

  private _emptyTree: string | undefined;
  async getEmptyTree(): Promise<string> {
    if (!this._emptyTree) {
      const result = await this.exec(['hash-object', '-t', 'tree', '/dev/null']);
      this._emptyTree = result.stdout.trim();
    }
    return this._emptyTree;
  }

  async getCommit(ref: string): Promise<Commit> {
    const result = await this.exec(['show', '-s', '--decorate=full', '--shortstat', `--format=${COMMIT_FORMAT}`, '-z', ref]);
    const commits = parseGitCommits(result.stdout);
    if (commits.length === 0) {
      return Promise.reject<Commit>('bad commit format');
    }
    return commits[0];
  }

  async exec(args: string[], buffer: true): Promise<ExecResult<Buffer>>;
  async exec(args: string[], buffer?: false): Promise<ExecResult<string>>;
  async exec(args: string[], buffer?: boolean): Promise<ExecResult<string | Buffer>> {
    const options: SpawnOptions = { cwd: this.root, stdio: ['ignore', null, null] };

    options.env = Object.assign({}, process.env, {
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
      GIT_PAGER: 'cat'
    });

    const child = cp.spawn('git', args, options);

    const bufferResult = await exec(child);

    const result: ExecResult<string | Buffer> = {
      exitCode: bufferResult.exitCode,
      stdout: buffer ? bufferResult.stdout : bufferResult.stdout.toString('utf8'),
      stderr: bufferResult.stderr,
    };

    if (result.exitCode) {
      return Promise.reject(new Error(bufferResult.stderr));
    }

    return result;
  }
}

async function exec(child: ChildProcess): Promise<ExecResult<Buffer>> {
  if (!child.stdout || !child.stderr) {
    throw new Error('Failed to get stdout or stderr from git process');
  }

  const disposables: Disposer[] = [];
  const on = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
    ee.on(name, fn);
    disposables.push(() => ee.removeListener(name, fn));
  };
  const once = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
    ee.once(name, fn);
    disposables.push(() => ee.removeListener(name, fn));
  };

  const exitCode = new Promise<number>((resolve, reject) => {
    once(child, 'error', reject);
    once(child, 'exit', resolve);
  });

  const stdout = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    on(child.stdout!, 'data', (chunk: Buffer) => chunks.push(chunk));
    once(child.stdout!, 'close', () => resolve(Buffer.concat(chunks)));
  });

  const stderr = new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    on(child.stderr!, 'data', (chunk: Buffer) => chunks.push(chunk));
    once(child.stderr!, 'close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  try {
    return { exitCode: await exitCode, stdout: await stdout, stderr: await stderr };
  } finally {
    disposables.forEach(dispose => dispose());
  }
}

const commitRegex = /([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?(?:\x00)(?:\n((?:.*)files? changed(?:.*))$)?/gm;

function parseGitCommits(data: string): Commit[] {
  const commits: Commit[] = [];

  let match: RegExpExecArray | null;
  while ((match = commitRegex.exec(data))) {
    let [, hash, authorName, authorEmail, authorDate, commitDate, parents, refNames, message, shortStat] = match;

    if (message.endsWith('\n')) {
      message = message.slice(0, -1);
    }

    // ` ${s}`.slice(1) forces creates a new string instead of a reference to the original huge string.
    commits.push({
      hash: ` ${hash}`.slice(1),
      message: ` ${message}`.slice(1),
      parents: parents ? parents.split(' ') : [],
      authorDate: new Date(Number(authorDate) * 1000),
      authorName: ` ${authorName}`.slice(1),
      authorEmail: ` ${authorEmail}`.slice(1),
      commitDate: new Date(Number(commitDate) * 1000),
      refNames: refNames.split(',').map(e => e.trim()).filter(isTruthy),
      shortStat: shortStat ? parseGitDiffShortStat(shortStat) : undefined
    });
  }

  return commits;
}

const diffShortStatRegex = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

function parseGitDiffShortStat(data: string): CommitShortStat {
  const match = data.trim().match(diffShortStatRegex);

  if (match) {
    const [, files, insertions, deletions] = match;
    return { files: Number.parseInt(files), insertions: Number.parseInt(insertions ?? 0), deletions: Number.parseInt(deletions ?? 0) };
  }

  return { files: 0, insertions: 0, deletions: 0 };
}

const lsTreeRegex = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/;

function parseLsTree(raw: string): LsTreeElement[] {
  const elements: LsTreeElement[] = [];

  let match: RegExpExecArray | null;
  for (const line of raw.split('\n')) {
    if (line && (match = lsTreeRegex.exec(line))) {
      const [, mode, type, object, size, file] = match;
      elements.push({ mode, type, object, size, file } as LsTreeElement);
    }
  }

  return elements;
}

// Git doesn't have a "folder" concept, so not need to check the blob type.
export function makeTree(elements: LsTreeElement[]): Tree<LsTreeElement> {
  const tree: Tree<LsTreeElement> = { children: [], collapsible: false, collapsed: false };

  for (const item of elements) {
    if (item.type === 'tree') {
      throw new Error('Unable to construct the files tree because "recursive" is not enabled.');
    }

    const parts = item.file.split('/');
    let current: Writable<Tree<LsTreeElement>> = tree, path = '', depth = 0;
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let child = current.children.find(e => e.data.file === path);
      if (!child) {
        const data: LsTreeElement = item.file === path ? item : {
          mode: '0', type: 'tree', object: '', size: '-', file: path
        };
        child = { data, children: [], depth, collapsible: false, collapsed: true };
        current.children.push(child);
        current.collapsible = true;
      }
      current = child;
      depth++;
    }
  }
  sortTree(tree);

  return tree;
}

function sortTree(tree: Tree<LsTreeElement>) {
  tree.children.sort(compareTreeNode);
  for (const child of tree.children) {
    sortTree(child);
  }
}

const collator = new Intl.Collator(undefined, { numeric: true });

function compareTreeNode(a: TreeNode<LsTreeElement>, b: TreeNode<LsTreeElement>): number {
  // Sort folders first.
  if (a.children.length > 0 && b.children.length === 0) return -1;
  if (a.children.length === 0 && b.children.length > 0) return 1;

  return collator.compare(a.data.file, b.data.file);
}
