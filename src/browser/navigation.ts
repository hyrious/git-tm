import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { FileReference } from '../common/symbols';

import { FileSource } from '../common/symbols';
import { clamp } from '../common/base';

export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface DiffLocation {
  readonly base: string;
  readonly oldPath: string;
  readonly status: string;
  readonly binary: boolean;
}

export interface NavigationLocation extends FileReference {
  readonly diff?: DiffLocation;
  readonly snapshot: string;
  readonly anchor: Position;
  readonly head: Position;
}

export interface NavigationEntry {
  readonly location: NavigationLocation;
  readonly saved: SavedSelection | undefined;
}

export interface SavedSelection {
  readonly version: string;
  readonly selection: { readonly anchor: number; readonly head: number; };
  readonly scroll: ReturnType<EditorView['scrollSnapshot']>;
}

export class NavigationHistory {
  private readonly entries: NavigationEntry[] = [];
  private index = -1;
  private active = false;

  get canGoBack(): boolean { return this.index >= (this.active ? 1 : 0); }
  get canGoForward(): boolean { return this.index + 1 < this.entries.length; }

  update(entry: NavigationEntry): void {
    if (this.active) this.entries[this.index] = entry;
  }

  leave(): void { this.active = false; }

  visit(entry: NavigationEntry): void {
    const current = this.entries[this.index];
    if (current && sameLocation(current, entry)) {
      this.entries[this.index] = entry;
    } else {
      this.entries.splice(++this.index, Infinity, entry);
    }
    this.active = true;
  }

  go(direction: -1 | 1): NavigationEntry | undefined {
    if (direction === -1 ? !this.canGoBack : !this.canGoForward) return;
    this.index += direction === -1 && !this.active ? 0 : direction;
    this.active = true;
    return this.entries[this.index];
  }
}

function sameLocation(a: NavigationEntry, b: NavigationEntry): boolean {
  const left = a.location, right = b.location;
  return left.snapshot === right.snapshot && left.source === right.source && left.path === right.path
    && left.diff?.base === right.diff?.base && left.diff?.oldPath === right.diff?.oldPath
    && left.diff?.status === right.diff?.status && left.diff?.binary === right.diff?.binary
    && a.saved?.version === b.saved?.version
    && left.anchor.line === right.anchor.line && left.anchor.column === right.anchor.column
    && left.head.line === right.head.line && left.head.column === right.head.column;
}

export function positionAt(doc: Text, offset: number): Position {
  offset = clamp(offset, 0, doc.length);
  const line = doc.lineAt(offset);
  return { line: line.number, column: offset - line.from + 1 };
}

export function offsetAt(doc: Text, position: Position): number {
  const line = doc.line(clamp(position.line, 1, doc.lines));
  return line.from + clamp(position.column - 1, 0, line.length);
}

export function formatLocation(location: NavigationLocation): string {
  const { snapshot, source, path, anchor, head } = location;
  const file = encodePath(path);
  let end = '';
  if (anchor.line !== head.line) {
    end = `-${head.line}:${head.column}`;
  } else if (anchor.column !== head.column) {
    end = `-${head.column}`;
  }
  const revision = snapshot === 'working-tree' ? 'WORKTREE' : snapshot;
  const prefix = source === FileSource.External ? 'external:' : '';
  const diff = location.diff;
  const revisions = diff ? `${diff.base}..${revision}` : revision;
  const files = diff && diff.oldPath !== path ? `${encodePath(diff.oldPath)}=>${file}` : file;
  const status = diff && diff.status !== 'M' ? `:${diff.status[0]}` : '';
  const binary = diff?.binary ? ':binary' : '';
  return `#${revisions}:${prefix}${files}:${anchor.line}:${anchor.column}${end}${status}${binary}`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function parseLocation(hash: string): NavigationLocation | undefined {
  const match = /^#(?:([\da-f]{4,64})\.\.)?(WORKTREE|[\da-f]{4,64}):(external:)?([^:]+):(\d+):(\d+)(?:-(?:(\d+):)?(\d+))?(?::([AMDTU]|[RC]\d*))?(?::(binary))?$/i.exec(hash);
  if (!match) return;
  const [, base, revision, external, files, line, column, endLine, endColumn, status, binary] = match;
  const anchor = { line: Number(line), column: Number(column) };
  const head = {
    line: endLine ? Number(endLine) : anchor.line,
    column: endColumn ? Number(endColumn) : anchor.column,
  };
  if (![anchor.line, anchor.column, head.line, head.column].every(n => Number.isSafeInteger(n) && n > 0)) return;
  if (base && external) return;
  if (!base && (status || binary)) return;
  try {
    const paths = files.split('=>');
    if (paths.length > (base ? 2 : 1) || paths.some(path => !path)) return;
    const oldPath = decodeURIComponent(paths[0]);
    const path = decodeURIComponent(paths.at(-1)!);
    let diff: DiffLocation | undefined;
    if (base) {
      diff = {
        base: base.toLowerCase(), oldPath,
        status: status?.[0].toUpperCase() ?? 'M', binary: !!binary,
      };
    }
    return {
      snapshot: revision.toUpperCase() === 'WORKTREE' ? 'working-tree' : revision.toLowerCase(),
      source: external ? FileSource.External : FileSource.Snapshot,
      path, anchor, head, diff,
    };
  } catch { }
}
