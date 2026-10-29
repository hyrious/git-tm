export const enum SnapshotKind {
  Commit,
  WorkingTree,
}

export interface Commit {
  readonly kind: SnapshotKind.Commit;
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
  readonly refNames: string[];
}

export interface CommitShortStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
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

export interface IBasicGitInfo {
  root: string;
  refs: Ref[];
  commits: Commit[];
  total: number;
  head: Ref;
  workingTree: WorkingTree | undefined;
}

export interface WorkingTree {
  readonly kind: SnapshotKind.WorkingTree;
  readonly date: Date;
  readonly parents: string[];
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

export type Snapshot = Commit | WorkingTree;

export interface Revision {
  readonly hash: string;
  readonly shortHash: string;
}

export interface DiffRange {
  readonly base: string;
  /** A missing target means the working directory. */
  readonly target?: string;
}

export interface DiffFile {
  readonly status: string;
  readonly oldPath: string;
  readonly newPath: string;
  /** Binary files have no line counts. */
  readonly insertions: number | null;
  readonly deletions: number | null;
}

export interface Diff {
  readonly range: DiffRange;
  readonly files: DiffFile[];
}

export function snapshotId(snapshot: Snapshot): string {
  return snapshot.kind === SnapshotKind.Commit ? snapshot.hash : 'working-tree';
}
