// Source taken from VS Code's builtin Git extension.

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Disposer } from '@wopjs/disposable';
import type { Commit, CommitShortStat, Diff, DiffFile, DiffRange, LsTreeElement, Ref, Revision, WorkingTree } from '../common/git';

import cp from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isTruthy } from '@wopjs/cast';
import { RefType, SnapshotKind } from '../common/git';
import { STEP } from '../common/base';

export interface LogOptions {
  readonly skip?: number;
  /** Default {@link STEP}. */
  readonly limit?: number | { readonly id: string; };
  readonly head?: string;
}

export interface ExecResult<T extends string | Uint8Array> {
  exitCode: number;
  stdout: T;
  stderr: string;
}

export interface LsTreeOptions {
  readonly path?: string;
  readonly recursive?: boolean;
}

const COMMIT_FORMAT = '%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B';

export class Repository {
  constructor(readonly root: string) { }

  async getState(): Promise<{ head: Ref; workingTree: WorkingTree | undefined; }> {
    const { stdout } = await this.exec(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    let name: string | undefined, commit: string | undefined;
    let staged = 0, unstaged = 0, untracked = 0;
    const records = stdout.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.startsWith('# branch.oid ')) {
        const oid = record.slice(13);
        if (oid !== '(initial)') commit = oid;
      } else if (record.startsWith('# branch.head ')) {
        const branch = record.slice(14);
        if (branch !== '(detached)') name = branch;
      } else if (record.startsWith('? ')) {
        untracked++;
      } else if (/^[12u] /.test(record)) {
        if (record[2] !== '.') staged++;
        if (record[3] !== '.') unstaged++;
        if (record[0] === '2') i++;
      }
    }
    return {
      head: { type: RefType.Head, name, commit },
      workingTree: staged || unstaged || untracked || !commit ? {
        kind: SnapshotKind.WorkingTree, date: new Date(), parents: commit ? [commit] : [],
        staged, unstaged, untracked,
      } : undefined,
    };
  }

  private async workingFiles(): Promise<string[]> {
    const { stdout } = await this.exec(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    return [...new Set(stdout.split('\0').filter(isTruthy))];
  }

  private async workingPath(file: string, directories: Set<string>): Promise<string> {
    const parts = file.split('/');
    if (path.isAbsolute(file) || parts.some(part => part === '..' || part === '.git')) {
      throw new Error('Invalid file path');
    }
    let parent = this.root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      if (directories.has(parent)) continue;
      if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('Cannot traverse a symbolic link');
      directories.add(parent);
    }
    return path.join(this.root, file);
  }

  async workingTree(): Promise<LsTreeElement[]> {
    const elements: LsTreeElement[] = [];
    const directories = new Set<string>();
    for (const file of await this.workingFiles()) {
      try {
        const stat = await fs.lstat(await this.workingPath(file, directories));
        elements.push({
          mode: stat.isSymbolicLink() ? '120000' : stat.isDirectory() ? '160000' : '100644',
          type: stat.isDirectory() ? 'commit' : 'blob',
          object: '', size: String(stat.size), file,
        });
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    return elements;
  }

  async lstree(treeish: string, options?: LsTreeOptions): Promise<LsTreeElement[]> {
    const args = ['-c', 'core.quotePath=false', 'ls-tree', '-lz', treeish];
    if (options?.recursive) {
      args.push('-r');
    }
    if (options?.path) {
      args.push('--', options.path);
    }
    const result = await this.exec(args);
    return parseLsTree(result.stdout);
  }

  async diff(ref?: string): Promise<Diff> {
    let base: string | undefined, target: string | undefined;
    if (ref) {
      const commit = await this.getCommit(ref);
      base = commit.parents[0];
      target = commit.hash;
    } else {
      base = (await this.getState()).head.commit;
    }
    const range: DiffRange = { base: base ?? await this.getEmptyTree(), target };
    const result = await this.exec([...this.diffArgs(range), '--raw', '--numstat', '-z', '--']);
    return { range, files: parseGitDiff(result.stdout) };
  }

  private diffArgs(range: DiffRange): string[] {
    for (const ref of [range.base, range.target]) {
      if (ref != null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) throw new Error('Invalid diff revision');
    }
    const args = ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', range.base];
    if (range.target) args.push(range.target);
    return args;
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
    const args = ['log', `--format=${COMMIT_FORMAT}`, '--topo-order', '--branches', '--remotes', '--tags', '-z'];
    if (options?.head) args.push(options.head);

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

    const result = await this.exec(args);
    return parseGitCommits(result.stdout);
  }

  async logSize(head?: string): Promise<number> {
    const args = ['rev-list', '--branches', '--remotes', '--tags', '--count'];
    if (head) args.push(head);
    const result = await this.exec(args);
    return Number.parseInt(result.stdout);
  }

  async shortStat(ref: string, signal?: AbortSignal): Promise<CommitShortStat> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) throw new Error('Invalid revision');
    const args = ['show', '--format=', '--shortstat', '--diff-merges=first-parent', '--end-of-options', ref, '--'];
    const result = await this.exec(args, false, signal);
    return parseGitDiffShortStat(result.stdout);
  }

  private _emptyTree: string | undefined;
  async getEmptyTree(): Promise<string> {
    if (!this._emptyTree) {
      const result = await this.exec(['hash-object', '-t', 'tree', '/dev/null']);
      this._emptyTree = result.stdout.trim();
    }
    return this._emptyTree;
  }

  async resolveRevision(ref: string): Promise<Revision> {
    if (!/^[\da-f]{4,64}$/i.test(ref)) throw new Error('Invalid revision');
    const full = await this.exec(['rev-parse', '--verify', `${ref}^{commit}`]);
    const hash = full.stdout.trim();
    const short = await this.exec(['rev-parse', '--short=7', hash]);
    return { hash, shortHash: short.stdout.trim() };
  }

  async getCommit(ref: string): Promise<Commit> {
    const result = await this.exec(['show', '-s', '--decorate=full', `--format=${COMMIT_FORMAT}`, '-z', '--end-of-options', ref]);
    const commits = parseGitCommits(result.stdout);
    if (commits.length === 0) {
      return Promise.reject<Commit>('bad commit format');
    }
    return commits[0];
  }

  async exec(args: string[], buffer: true, signal?: AbortSignal): Promise<ExecResult<Buffer>>;
  async exec(args: string[], buffer?: false, signal?: AbortSignal): Promise<ExecResult<string>>;
  async exec(args: string[], buffer?: boolean, signal?: AbortSignal): Promise<ExecResult<string | Buffer>> {
    const options: SpawnOptions = { cwd: this.root, stdio: ['ignore', null, null], signal };

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

const commitRegex = /([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?\x00/gm;

function parseGitCommits(data: string): Commit[] {
  const commits: Commit[] = [];

  let match: RegExpExecArray | null;
  while ((match = commitRegex.exec(data))) {
    let [, hash, authorName, authorEmail, authorDate, commitDate, parents, refNames, message] = match;

    if (message.endsWith('\n')) {
      message = message.slice(0, -1);
    }

    // ` ${s}`.slice(1) forces creates a new string instead of a reference to the original huge string.
    commits.push({
      kind: SnapshotKind.Commit,
      hash: ` ${hash}`.slice(1),
      message: ` ${message}`.slice(1),
      parents: parents ? parents.split(' ') : [],
      authorDate: new Date(Number(authorDate) * 1000),
      authorName: ` ${authorName}`.slice(1),
      authorEmail: ` ${authorEmail}`.slice(1),
      commitDate: new Date(Number(commitDate) * 1000),
      refNames: refNames.split(',').map(e => e.trim()).filter(isTruthy),
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

function parseGitDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const records = raw.split('\0');
  let index = 0;
  while (records[index]?.startsWith(':')) {
    const status = records[index++].split(' ')[4];
    const oldPath = records[index++];
    const newPath = /^[RC]/.test(status) ? records[index++] : oldPath;
    files.push({ status, oldPath, newPath, insertions: null, deletions: null });
  }
  for (let i = 0; i < files.length; i++) {
    const record = records[index++];
    const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
    const insertions = record.slice(0, first), deletions = record.slice(first + 1, second);
    // Renames have an empty path followed by two NUL-delimited paths.
    if (second === record.length - 1) index += 2;
    files[i] = {
      ...files[i],
      insertions: insertions === '-' ? null : Number(insertions),
      deletions: deletions === '-' ? null : Number(deletions),
    };
  }
  return files;
}

const lsTreeRegex = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\t([^]*)$/;

function parseLsTree(raw: string): LsTreeElement[] {
  const elements: LsTreeElement[] = [];

  let match: RegExpExecArray | null;
  for (const line of raw.split('\0')) {
    if (line && (match = lsTreeRegex.exec(line))) {
      const [, mode, type, object, size, file] = match;
      elements.push({ mode, type, object, size, file } as LsTreeElement);
    }
  }

  return elements;
}

