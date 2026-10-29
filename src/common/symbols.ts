export const enum FileSource {
  Snapshot,
  External,
}

export interface FileReference {
  readonly source: FileSource;
  readonly path: string;
}

export interface FileLocation extends FileReference {
  readonly from: number;
  readonly to: number;
  readonly version?: string;
}

export interface FileContents {
  readonly bytes: Uint8Array;
  readonly version: string;
}

export const enum SymbolAction {
  FileSymbols,
  WorkspaceSymbols,
  Definition,
  References,
  Related,
  Index,
}

export interface SymbolQuery {
  readonly action: SymbolAction;
  readonly file?: FileReference;
  readonly version?: string;
  readonly position?: number;
}

export interface SymbolLocation extends FileLocation {
  readonly name: string;
  readonly kind: string;
  readonly container: string;
  readonly line: number;
  readonly preview: string;
}

export interface SymbolResults {
  readonly locations: SymbolLocation[];
  readonly stale: boolean;
  readonly files?: readonly FileSymbols[];
}

export interface FileSymbols extends FileReference {
  readonly version: string;
  readonly locations: SymbolLocation[];
}

export function supportsSymbols(path: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(path);
}
