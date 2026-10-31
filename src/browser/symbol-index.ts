import type { Snapshot } from '../common/git';
import type { FileSymbols, SymbolLocation } from '../common/symbols';
import type { Git } from './git';

import { LanguageDescription } from '@codemirror/language';
import { languages } from './languages';
import { EditorState } from '@codemirror/state';
import { writable } from '@embra/reactivity';
import { Disposable } from '../common/disposable';
import { FileSource, SymbolAction, supportsSymbols } from '../common/symbols';
import { decodeText } from '../common/base';
import { syntaxSymbols } from './syntax-symbols';

export class SymbolIndex {
  readonly groups = new Map<string, SymbolLocation[]>();
  readonly files = new Map<string, FileSymbols>();
  private readonly locations = new Set<string>();

  private add(locations: readonly SymbolLocation[]): void {
    for (const location of locations) {
      const key = JSON.stringify([location.name, location.source, location.path, location.from, location.to]);
      if (this.locations.has(key)) continue;
      this.locations.add(key);
      let group = this.groups.get(location.name);
      if (!group) this.groups.set(location.name, group = []);
      group.push(location);
    }
  }

  async load(
    git: Git,
    snapshot: Snapshot,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ): Promise<void> {
    const active = () => !signal.aborted;
    const [result, paths] = await Promise.all([
      git.symbols(snapshot, { action: SymbolAction.Index }, signal),
      git.paths(snapshot),
    ]);
    if (!active()) return;
    this.add(result.locations);
    for (const file of result.files ?? []) {
      file.locations.sort(compareSymbolLocation);
      this.files.set(file.path, file);
    }
    const pending = paths.filter(path => !supportsSymbols(path) && LanguageDescription.matchFilename(languages, path));
    let completed = paths.length - pending.length;
    progress(paths.length ? Math.floor(completed * 100 / paths.length) : 100);
    for (const path of pending) {
      if (!active()) return;
      const file = { source: FileSource.Snapshot, path };
      try {
        const contents = await git.contents(file, snapshot);
        if (!active()) return;
        if (contents.bytes.subarray(0, 8000).includes(0)) continue;
        const state = EditorState.create({ doc: decodeText(contents.bytes) });
        const locations = await syntaxSymbols(file, state, contents.version, active);
        if (!active()) return;
        locations.sort(compareSymbolLocation);
        this.files.set(path, { ...file, version: contents.version, locations });
        this.add(locations);
      } catch {
        // Files without a usable syntax parser do not prevent semantic indexing.
      } finally {
        if (active()) progress(Math.floor(++completed * 100 / paths.length));
      }
    }
    if (!active()) return;
    for (const group of this.groups.values()) group.sort(compareSymbolLocation);
  }
}

interface IndexTask {
  readonly snapshot: Snapshot;
  readonly index: SymbolIndex;
  readonly controller: AbortController;
  ready: Promise<void>;
  pending: boolean;
  error: unknown;
}

/** A snapshot owns its index independently of any search dialog. */
export class SnapshotIndex extends Disposable {
  readonly progress$ = this._register(writable<number | undefined | null>(null));
  current: IndexTask | undefined;

  constructor(git: Git) {
    super();
    this._register(() => {
      this.current?.controller.abort();
      this.current = undefined;
    });
    this._register(git.snapshot$.subscribe(snapshot => {
      this.current?.controller.abort();
      this.current = undefined;
      this.progress$.set(snapshot ? undefined : null);
      if (!snapshot) return;
      const task: IndexTask = {
        snapshot, index: new SymbolIndex(), controller: new AbortController(),
        ready: Promise.resolve(), pending: true, error: undefined,
      };
      this.current = task;
      const active = () => this.current === task;
      task.ready = Promise.resolve().then(async () => {
        if (!active()) return;
        try {
          await task.index.load(git, snapshot, task.controller.signal, percent => this.progress$.set(percent));
        } catch (error) {
          task.error = error;
          if (active()) console.error(error);
        } finally {
          task.pending = false;
          if (active()) this.progress$.set(null);
        }
      });
    }));
  }
}

export function compareSymbolLocation(a: SymbolLocation, b: SymbolLocation): number {
  return compareSymbolPriority(a, b) || a.path.localeCompare(b.path) || a.from - b.from;
}

export function compareSymbolPriority(a: SymbolLocation, b: SymbolLocation): number {
  return Number(/(?:^|[/\\])node_modules(?:[/\\]|$)/.test(a.path)) - Number(/(?:^|[/\\])node_modules(?:[/\\]|$)/.test(b.path));
}
