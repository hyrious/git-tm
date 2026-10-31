import type { FileLocation, SymbolLocation, SymbolQuery } from '../common/symbols';
import type { Snapshot } from '../common/git';
import type { Writable } from '../common/base';
import type { NavigationEntry } from './navigation';
import type { TextMatch } from './search-match';

import { appendChild, listen } from '@wopjs/dom';
import { LanguageDescription } from '@codemirror/language';
import { languages } from './languages';
import { clamp } from '../common/base';
import { SnapshotKind } from '../common/git';
import { FileSource, SymbolAction, supportsSymbols } from '../common/symbols';
import { decodeText } from '../common/base';
import { syntaxSymbols } from './syntax-symbols';
import { compareSymbolLocation, compareSymbolPriority } from './symbol-index';
import { $, onCustomEvent } from './dom';
import { fuzzyScore, searchPattern, textLines, textMatches } from './search-match';
import { Widget } from './widget';
import { Scrollbars } from './scrollbars';
import { createCommitContent, renderCommitContent } from './commit-content';
import { bindKeys } from './keybindings';

const enum SearchMode {
  Files,
  File,
  Global,
  Commits,
  FileSymbols,
  WorkspaceSymbols,
  Definition,
  References,
  Related,
  SymbolLocations,
}

interface FileResult {
  readonly path: string;
  readonly score: number;
}

interface TextResult {
  readonly path: string;
  readonly match: TextMatch;
}

interface CommitResult {
  readonly snapshot: Snapshot;
  readonly index: number;
}

interface ScoredSymbol {
  readonly location: SymbolLocation;
  readonly score: number;
}

interface FileSearch {
  readonly mode: SearchMode.Files;
  readonly results: FileResult[];
}

interface TextSearch {
  readonly mode: SearchMode.File | SearchMode.Global;
  readonly results: TextResult[];
  previewed: boolean;
}

interface CommitSearch {
  readonly mode: SearchMode.Commits;
  readonly results: CommitResult[];
  readonly compare: boolean;
}

interface SymbolSearch {
  readonly mode: SymbolMode;
  readonly results: SymbolLocation[];
}

type SearchState = FileSearch | TextSearch | CommitSearch | SymbolSearch;
type Mode = SearchState['mode'];
type SymbolMode = SearchMode.FileSymbols | SearchMode.WorkspaceSymbols | SearchMode.Definition | SearchMode.References | SearchMode.Related | SearchMode.SymbolLocations;

interface SymbolStep {
  readonly name: string;
  readonly input: string;
  readonly selected: number;
}

interface SearchMemory {
  readonly input: string;
  readonly selected: number;
  readonly path: string | undefined;
}

interface SearchSession {
  readonly snapshot: Snapshot | undefined;
  readonly texts: Map<string, string | undefined | Promise<string | undefined>>;
  paths: readonly string[] | undefined;
  symbols: readonly SymbolLocation[] | undefined;
  groups: Map<string, SymbolLocation[]>;
  error: Error | undefined;
}

const limit = 200;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export class Search extends Widget {
  readonly $dialog: HTMLDialogElement;
  readonly $input: HTMLInputElement;
  readonly $list: HTMLElement;
  readonly $note: HTMLElement;
  readonly scrollbars: Scrollbars;
  readonly memory = new Map<SearchMode.File | SearchMode.Global, SearchMemory>();

  state: SearchState = createState(SearchMode.Files);
  generation = 0;
  composing = false;

  private publishedGeneration = 0;
  private selected = 0;
  private origin: NavigationEntry | undefined;
  private session: SearchSession | undefined;
  private symbolStep: SymbolStep | undefined;

  override initialize(this: Writable<this>): void {
    this.$dialog = appendChild(this.parent, $('dialog.search'));
    this.$input = appendChild(this.$dialog, $('input.search-input'));
    this.$list = appendChild(this.$dialog, $('.search-results'));
    this.$note = appendChild(this.$dialog, $('.search-note'));
    this.scrollbars = this._register(new Scrollbars(this.$list));
    this.$input.type = 'text';
    this.$input.spellcheck = false;
    this.$input.autocomplete = 'off';
    this.$input.setAttribute('role', 'combobox');
    this.$input.setAttribute('aria-autocomplete', 'list');
    this.$input.setAttribute('aria-controls', 'search-results');
    this.$input.setAttribute('aria-expanded', 'true');
    this.$input.setAttribute('aria-describedby', 'search-note');
    this.$list.id = 'search-results';
    this.$list.setAttribute('role', 'listbox');
    this.$note.id = 'search-note';
    this.$note.setAttribute('role', 'status');
    this._register(() => this.$dialog.remove());
    this._register(() => this.close());

    const canQuerySymbols = () => !!this.root.editor.editor?.hasFocus;
    this._register(bindKeys(window, {
      'Mod+f': { when: () => this.root.editor.editor != null, run: () => this.toggle(SearchMode.File) },
      'Mod+Shift+f': () => this.toggle(SearchMode.Global),
      'Mod+p': () => this.toggle(SearchMode.Files),
      'Mod+k': () => this.toggle(SearchMode.Commits),
      'Mod+Shift+k': { when: () => this.root.editor.canCompare(), run: () => this.toggle(SearchMode.Commits, true) },
      'Mod+r': { when: canQuerySymbols, run: () => this.toggle(SearchMode.FileSymbols) },
      'Mod+Alt+o': { when: canQuerySymbols, run: () => this.toggle(SearchMode.FileSymbols) },
      'Mod+Shift+r': { when: canQuerySymbols, run: () => this.toggle(SearchMode.WorkspaceSymbols) },
      'F12': { when: canQuerySymbols, run: () => this.toggle(SearchMode.Definition) },
      'Shift+F12': { when: canQuerySymbols, run: () => this.toggle(SearchMode.References) },
      'Mod+Alt+F12': { when: canQuerySymbols, run: () => this.toggle(SearchMode.Related) },
    }));
    this._register(listen(this.$input, 'input', e => {
      if (!(e as InputEvent).isComposing) this.run();
    }));
    this._register(listen(this.$input, 'compositionstart', () => {
      this.composing = true;
      this.generation++;
      this.$note.textContent = '';
    }));
    this._register(listen(this.$input, 'compositionend', () => {
      this.composing = false;
      this.run();
    }));
    this._register(bindKeys(this.$dialog, {
      'Mod+r,Mod+Shift+r': () => this.close(),
      'ArrowDown,ArrowUp': { repeat: true, run: e => this.onArrowKey(e) },
      'PageUp,PageDown': { repeat: true, run: e => this.onPageKey(e) },
      'Enter': () => this.accept(),
      'Backspace': {
        when: e => this.state.mode === SearchMode.SymbolLocations && e.target === this.$input && !this.$input.value,
        run: () => this.back(),
      },
    }));
    this._register(listen(this.$dialog, 'cancel', e => { e.preventDefault(); this.back(); }));
    this._register(listen(this.$dialog, 'click', e => {
      if (e.target === this.$dialog) {
        const rect = this.$dialog.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) this.close();
      }
    }));
    this._register(listen(this.$list, 'mousedown', e => e.preventDefault()));
    this._register(listen(this.$list, 'click', e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (row) { this.select(Number(row.dataset.index)); this.accept(); }
    }));
    this._register(this.root.git.snapshot$.subscribe(() => {
      this.close(false);
      this.memory.clear();
    }));
    this._register(onCustomEvent('editor.clear', () => {
      if (!this.root.editor.previewing) this.close(false);
    }));
  }

  onArrowKey(e: KeyboardEvent): void {
    const count = this.state.results.length;
    if (count) {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.select((this.selected + step + count) % count);
    }
  }

  onPageKey(e: KeyboardEvent): void {
    const count = this.state.results.length;
    if (count) {
      const step = e.key === 'PageUp' ? -10 : 10;
      this.select(clamp(this.selected + step, 0, count - 1));
    }
  }

  toggle(mode: Mode, compare = false): void {
    const sameMode = this.state.mode === mode;
    const sameCompare = this.state.mode !== SearchMode.Commits || this.state.compare === compare;
    if (this.session && sameMode && sameCompare) {
      this.close();
      return;
    }
    this.open(mode, compare);
  }

  private show(): void {
    this.$dialog.showModal();
    this.$input.focus();
    this.$input.select();
  }

  private open(mode: Mode, compare = false): void {
    this.close();
    this.state = createState(mode, compare);
    const memory = mode === SearchMode.File || mode === SearchMode.Global ? this.memory.get(mode) : undefined;
    const view = this.root.editor.editor;
    const selection = view?.state.selection;
    if (mode !== SearchMode.Commits) this.origin = this.root.editor.beginPreview();
    const session: SearchSession = {
      snapshot: this.root.git.snapshot$.value, texts: new Map(),
      paths: undefined, symbols: undefined, groups: new Map(), error: undefined,
    };
    this.session = session;
    this.composing = false;
    this.setLabel(mode);
    this.$input.value = memory?.input ?? (mode === SearchMode.File && view
      ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : '');
    const navigation = mode === SearchMode.Definition || mode === SearchMode.References || mode === SearchMode.Related;
    if (!navigation) {
      this.show();
      this.run(memory && (mode === SearchMode.Global || memory.path === this.root.editor.path) ? memory.selected : 0);
    }
    if (mode === SearchMode.Files || mode === SearchMode.Global || isSymbolMode(mode)) this.load(session, mode).then(() => {
      if (this.session !== session) return;
      if (navigation) {
        if (!view || view !== this.root.editor.editor || !selection?.eq(view.state.selection)) {
          this.close(false);
          return;
        }
        if (session.symbols?.length === 1) {
          this.close(false, session.symbols[0]);
          return;
        }
        this.show();
      }
      this.refresh();
    }).catch(error => {
      if (this.session === session) {
        session.error = error instanceof Error ? error : new Error(String(error));
        if (!this.$dialog.open) this.show();
        this.run();
      }
    });
  }

  close(restore = true, location?: string | FileLocation): void {
    if (!this.session && !this.$dialog.open) return;
    if (this.state.mode === SearchMode.File || this.state.mode === SearchMode.Global) {
      this.memory.set(this.state.mode, {
        input: this.$input.value,
        selected: this.selected,
        path: this.origin?.location.path ?? this.root.editor.path,
      });
    }
    this.generation++;
    this.session = undefined;
    this.symbolStep = undefined;
    if (this.state.mode === SearchMode.File) this.root.editor.highlight([]);
    this.origin = undefined;
    this.scrollbars.reset();
    this.$dialog.close();
    this.root.editor.endPreview(restore, location);
  }

  back(): void {
    const step = this.symbolStep;
    if (!step) { this.close(); return; }
    this.symbolStep = undefined;
    this.root.editor.resetPreview();
    this.state = createState(SearchMode.WorkspaceSymbols);
    this.setLabel(SearchMode.WorkspaceSymbols);
    this.$input.value = step.input;
    this.$input.focus();
    this.run(step.selected);
    if (isSymbolSearch(this.state)) {
      const index = this.state.results.findIndex(location => location.name === step.name);
      if (index >= 0) this.select(index);
    }
  }

  private setLabel(mode: Mode): void {
    let label = labels[mode];
    if (mode === SearchMode.SymbolLocations) {
      label = `Locations of ${this.symbolStep!.name}`;
    } else if (this.state.mode === SearchMode.Commits && this.state.compare) {
      label = 'Compare file with commit';
    }
    this.$dialog.ariaLabel = label;
    this.$input.ariaLabel = label;
    if (mode === SearchMode.Files) {
      this.$input.placeholder = 'Search files by name…';
    } else if (mode === SearchMode.SymbolLocations) {
      this.$input.placeholder = `${label}: search paths…`;
    } else if (isSymbolMode(mode)) {
      this.$input.placeholder = `${label}…`;
    } else {
      this.$input.placeholder = `${label}: text or /pattern/`;
    }
  }

  private refresh(): void {
    const symbol = isSymbolSearch(this.state) ? this.state.results[this.selected] : undefined;
    this.run(this.selected, symbol);
  }

  run(selected = 0, symbol?: SymbolLocation): void {
    const session = this.session;
    if (!session || this.composing) return;
    const generation = ++this.generation;
    const state = createState(this.state.mode, this.state.mode === SearchMode.Commits && this.state.compare), input = this.$input.value;
    this.selected = selected;
    this.$list.scrollTop = 0;
    this.$note.textContent = '';
    this.$input.removeAttribute('aria-invalid');
    if (session.error) {
      this.showError(session.error, generation);
      return;
    }
    const missingSnapshot = state.mode !== SearchMode.Commits && !session.snapshot;
    const emptyTextSearch = (state.mode === SearchMode.File || state.mode === SearchMode.Global) && !input;
    if (missingSnapshot || emptyTextSearch) {
      this.publish(state, generation);
      return;
    }
    try {
      switch (state.mode) {
        case SearchMode.Files:
          this.searchFiles(state, session.paths ?? [], input);
          break;
        case SearchMode.File:
        case SearchMode.Global:
          if (state.mode === SearchMode.Global && !session.paths) break;
          this.searchText(state, session, input, generation).then(skipped => {
            if (generation !== this.generation) return;
            this.publish(state, generation);
            if (skipped) this.$note.textContent += ` ${skipped} files could not be read.`;
          }).catch(error => this.showError(error, generation));
          return;
        case SearchMode.Commits:
          this.searchCommits(state, input, generation).then(() => this.publish(state, generation))
            .catch(error => this.showError(error, generation));
          return;
        default:
          let locations = session.symbols ?? [];
          if (state.mode === SearchMode.WorkspaceSymbols) {
            locations = Array.from(session.groups.values(), group => group[0])
              .sort((a, b) => compareSymbolPriority(a, b) || a.name.localeCompare(b.name));
          } else if (state.mode === SearchMode.SymbolLocations) {
            locations = session.groups.get(this.symbolStep!.name) ?? [];
          }
          this.searchSymbols(state, locations, input);
          if (symbol) {
            const index = state.results.findIndex(location => {
              if (state.mode === SearchMode.WorkspaceSymbols) return location.name === symbol.name;
              return location === symbol;
            });
            if (index >= 0) this.selected = index;
          }
          break;
      }
      this.publish(state, generation);
    } catch (error) {
      this.showError(error, generation);
    }
  }

  select(index: number): void {
    if (this.publishedGeneration !== this.generation || !this.state.results[index]) return;
    this.selected = index;
    for (const row of this.$list.children) {
      row.ariaSelected = String((row as HTMLElement).dataset.index === String(index));
    }
    this.$input.setAttribute('aria-activedescendant', `search-result-${index}`);
    this.$list.children[index]?.scrollIntoView({ block: 'nearest' });
    const state = this.state;
    if (state.mode === SearchMode.WorkspaceSymbols) return;
    if (state.mode === SearchMode.File) {
      const match = state.results[index]?.match;
      if (match) this.root.editor.reveal(match.from, match.to);
    } else if (state.mode === SearchMode.Files) {
      const path = state.results[index].path;
      if (!this.$input.value && path === this.root.editor.path) return;
      this.root.editor.openFile(path, true);
    } else if (state.mode === SearchMode.Global) {
      const { path, match } = state.results[index];
      this.root.editor.openFile({ source: FileSource.Snapshot, path, from: match.from, to: match.to }, true);
    } else if (isSymbolSearch(state)) {
      this.root.editor.openFile(state.results[index], true);
    }
  }

  accept(): void {
    if (this.publishedGeneration !== this.generation) return;
    const state = this.state, index = this.selected, origin = this.origin;
    if (!state.results[index]) return;
    switch (state.mode) {
      case SearchMode.WorkspaceSymbols: {
        const name = state.results[index].name;
        const locations = this.session?.groups.get(name);
        if (locations?.length === 1) {
          this.close(false, locations[0]);
          break;
        }
        this.symbolStep = { name, input: this.$input.value, selected: index };
        this.state = createState(SearchMode.SymbolLocations);
        this.setLabel(SearchMode.SymbolLocations);
        this.$input.value = '';
        this.run();
        break;
      }
      case SearchMode.Commits:
        this.close(false);
        if (state.compare) this.root.editor.compare(state.results[index].snapshot);
        else this.root.commits.accept(state.results[index].index);
        break;
      case SearchMode.File: {
        const { match } = state.results[index];
        this.close(false);
        this.root.editor.jump(match.from, match.to, origin);
        break;
      }
      case SearchMode.Files:
      case SearchMode.Global: {
        const match = state.mode === SearchMode.Global ? state.results[index].match : undefined;
        this.close(false, { source: FileSource.Snapshot, path: state.results[index].path, from: match?.from ?? 0, to: match?.to ?? 0 });
        break;
      }
      default: {
        this.close(false, state.results[index]);
      }
    }
  }

  override layout(): void { }

  private async load(session: SearchSession, mode: Mode): Promise<void> {
    const snapshot = session.snapshot;
    if (!snapshot) return;
    if (mode === SearchMode.Files || mode === SearchMode.Global) {
      session.paths = (await this.root.git.paths(snapshot)).sort((a, b) => a.localeCompare(b));
    } else if (isSymbolMode(mode) && mode !== SearchMode.SymbolLocations) {
      const document = this.root.editor.document, view = this.root.editor.editor;
      const state = view?.state;
      const active = () => this.session === session;
      const task = this.root.symbolIndex.current;
      const index = task?.snapshot === snapshot && !task.pending ? task.index : undefined;
      if (mode === SearchMode.WorkspaceSymbols) {
        if (task?.snapshot !== snapshot) return;
        await task.ready;
        if (!active()) return;
        if (task?.error) throw task.error;
        session.groups = task.index.groups;
        if (active() && !session.groups.size) this.fallbackToText();
      } else if (!document || !supportsSymbols(document.file.path)) {
        if (!document || !state || mode === SearchMode.References || mode === SearchMode.Related) {
          this.fallbackToText();
          return;
        }
        let locations: SymbolLocation[];
        const cached = index?.files.get(document.file.path);
        try {
          if (cached?.source === document.file.source && cached.version === document.version) {
            locations = cached.locations;
          } else {
            locations = await syntaxSymbols(document.file, state, document.version, active);
            locations.sort(compareSymbolLocation);
          }
        }
        catch { locations = []; }
        if (!active()) return;
        if (mode === SearchMode.Definition) {
          const selection = state.selection.main;
          const word = selection.empty ? state.wordAt(selection.head) : selection;
          const name = word ? state.sliceDoc(word.from, word.to) : '';
          locations = locations.filter(location => location.name === name);
        }
        if (locations.length) session.symbols = locations;
        else this.fallbackToText();
      } else {
        const cached = index?.files.get(document.file.path);
        if (mode === SearchMode.FileSymbols && cached?.source === document.file.source && cached.version === document.version) {
          session.symbols = cached.locations;
          return;
        }
        const query: SymbolQuery = {
          action: symbolActions[mode], file: document.file,
          version: document.version, position: state?.selection.main.head,
        };
        const result = await this.root.git.symbols(snapshot, query);
        if (!active()) return;
        if (result.stale) {
          this.root.editor.endPreview(false);
          await this.root.editor.refreshFile();
          if (!active()) return;
          this.origin = this.root.editor.beginPreview();
          throw new Error('File changed. Run the symbol command again.');
        }
        session.symbols = result.locations.sort(compareSymbolLocation);
      }
    }
  }

  private fallbackToText(): void {
    const input = this.$input.value;
    this.toggle(SearchMode.File);
    if (input) {
      this.$input.value = input;
      this.run();
    }
  }

  private showError(error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    this.publish(createState(this.state.mode, this.state.mode === SearchMode.Commits && this.state.compare), generation);
    this.$note.textContent = error instanceof Error ? error.message : 'Could not complete search.';
    this.$input.setAttribute('aria-invalid', String(error instanceof SyntaxError));
  }

  private searchSymbols(state: SymbolSearch, locations: readonly SymbolLocation[], input: string): void {
    if (!input) {
      state.results.push(...locations.slice(0, limit));
      return;
    }
    const scored: ScoredSymbol[] = [];
    for (const location of locations) {
      const score = fuzzyScore(input, symbolSearchText(location, state.mode));
      if (score !== -Infinity) scored.push({ location, score });
    }
    scored.sort((a, b) => {
      const priority = compareSymbolPriority(a.location, b.location);
      if (priority) return priority;
      const score = b.score - a.score;
      if (score) return score;
      const name = a.location.name.localeCompare(b.location.name);
      if (name) return name;
      return compareSymbolLocation(a.location, b.location);
    });
    for (const { location } of scored.slice(0, limit)) state.results.push(location);
  }

  private searchFiles(state: FileSearch, paths: readonly string[], input: string): void {
    if (!input) {
      const current = this.origin?.location.path ?? this.root.editor.path;
      if (current != null && paths.includes(current)) {
        state.results.push({ path: current, score: 100 });
      }
      for (const path of paths) {
        if (state.results.length >= limit) break;
        if (path !== current) state.results.push({ path, score: 100 });
      }
      return;
    }
    for (const path of paths) {
      const score = fuzzyScore(input, path);
      if (score !== -Infinity) state.results.push({ path, score });
    }
    state.results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    state.results.length = Math.min(state.results.length, limit);
  }

  private async searchText(state: TextSearch, session: SearchSession, input: string, generation: number): Promise<number> {
    const pattern = searchPattern(input);
    const snapshot = session.snapshot;
    const view = this.root.editor.editor;
    if (!snapshot) return 0;
    const paths = state.mode === SearchMode.File ? [this.root.editor.path ?? ''] : session.paths ?? [];
    if (generation !== this.generation) return 0;
    let deadline = performance.now() + 8, skipped = 0;
    for (const path of paths) {
      if (generation !== this.generation) return skipped;
      let lines: Iterable<string>;
      if (state.mode === SearchMode.File) {
        if (!view || view !== this.root.editor.editor) return skipped;
        lines = view.state.doc.iterLines();
      } else {
        let text: string | undefined;
        try {
          let cached = session.texts.get(path);
          if (!session.texts.has(path)) {
            cached = this.root.git.blob(path, snapshot).then(bytes => {
              const text = bytes.subarray(0, 8000).includes(0) ? undefined : decodeText(bytes);
              session.texts.set(path, text);
              return text;
            });
            session.texts.set(path, cached);
          }
          if (cached instanceof Promise) {
            if (state.results.length) this.publish(state, generation, false);
            text = await cached;
          } else text = cached;
        } catch { skipped++; continue; }
        if (generation !== this.generation) return skipped;
        if (text == null) continue;
        lines = textLines(text);
      }
      for (const match of textMatches(lines, pattern)) {
        if (match) state.results.push({ path, match });
        if (state.results.length >= limit) return skipped;
        if (performance.now() >= deadline) {
          this.publish(state, generation, false);
          await pause();
          if (generation !== this.generation) return skipped;
          deadline = performance.now() + 8;
        }
      }
    }
    return skipped;
  }

  private async searchCommits(state: CommitSearch, input: string, generation: number): Promise<void> {
    const pattern = input ? searchPattern(input) : undefined;
    const git = this.root.git;
    let deadline = performance.now() + 8;
    for (let index = 0; index < git.history.length; index++) {
      if (generation !== this.generation) return;
      if (git.history[index] == null) {
        this.publish(state, generation, false);
        await git.touch(index + 1);
        if (generation !== this.generation) return;
      }
      const snapshot = git.history[index];
      if (pattern) pattern.lastIndex = 0;
      if (state.compare && snapshot?.kind !== SnapshotKind.Commit) continue;
      if (snapshot && (!pattern || pattern.test(snapshot.kind === SnapshotKind.WorkingTree ? 'Working Directory' : snapshot.message))) {
        state.results.push({ snapshot, index });
        if (state.results.length >= limit) return;
      }
      if (performance.now() >= deadline) {
        this.publish(state, generation, false);
        await pause();
        if (generation !== this.generation) return;
        deadline = performance.now() + 8;
      }
    }
  }

  private publish(state: SearchState, generation: number, complete = true): void {
    if (generation !== this.generation) return;
    this.state = state;
    this.publishedGeneration = generation;
    if (complete && state.results.length) this.selected = Math.min(this.selected, state.results.length - 1);
    this.render();
    if (complete && this.selected > 0) this.$list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
    this.scrollbars.update(true);
    this.$note.textContent = '';
    if (state.mode === SearchMode.WorkspaceSymbols && this.root.symbolIndex.current?.pending) {
      this.$note.textContent = 'Indexing…';
    }
    if (complete && state.mode !== SearchMode.File && state.mode !== SearchMode.Commits && state.results.length) this.select(this.selected);
    if (state.mode === SearchMode.File) {
      this.root.editor.highlight(state.results.map(result => result.match));
      if (!state.previewed && state.results.length > this.selected) {
        state.previewed = true;
        this.select(this.selected);
      }
    }
  }

  private render(): void {
    const state = this.state;
    switch (state.mode) {
      case SearchMode.Files:
        this.renderResults(state.results, (row, result) => renderFile(row, result, this.$input.value));
        break;
      case SearchMode.File:
      case SearchMode.Global:
        this.renderResults(state.results, renderText);
        break;
      case SearchMode.WorkspaceSymbols:
        this.renderResults(state.results, (row, result) => {
          renderSymbol(row, result, state.mode, this.$input.value, this.session?.groups.get(result.name));
        });
        break;
      case SearchMode.Commits:
        this.renderResults(state.results, (row, result) => renderCommit(row, result, this.$input.value));
        break;
      default:
        this.renderResults(state.results, (row, result) => renderSymbol(row, result, state.mode, this.$input.value));
        break;
    }
    if (state.results.length) this.$input.setAttribute('aria-activedescendant', `search-result-${this.selected}`);
    else this.$input.removeAttribute('aria-activedescendant');
  }

  private renderResults<T>(results: readonly T[], render: (row: HTMLElement, result: T) => void): void {
    const fragment = document.createDocumentFragment();
    results.forEach((result, index) => {
      const row = $('.search-result');
      row.id = `search-result-${index}`;
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.ariaSelected = String(index === this.selected);
      render(row, result);
      fragment.append(row);
    });
    this.$list.replaceChildren(fragment);
  }
}

function createState(mode: Mode, compare = false): SearchState {
  switch (mode) {
    case SearchMode.Files: return { mode, results: [] };
    case SearchMode.File:
    case SearchMode.Global: return { mode, results: [], previewed: false };
    case SearchMode.Commits: return { mode, results: [], compare };
    default: return { mode, results: [] };
  }
}

function renderFile(row: HTMLElement, result: FileResult, input: string): void {
  const title = appendChild(row, $('.search-result-title'));
  const positions: number[] = [];
  fuzzyScore(input, result.path, positions);
  const filename = result.path.lastIndexOf('/') + 1;
  appendMatches(title, result.path.slice(filename), positions.filter(position => position >= filename).map(position => position - filename));
  const detail = appendChild(row, $('.search-result-detail'));
  appendMatches(detail, result.path, positions);
  row.title = result.path;
}

function renderText(row: HTMLElement, { path, match }: TextResult): void {
  row.classList.add('search-result-match');
  const title = appendChild(row, $('.search-result-title'));
  const mark = $('mark');
  mark.textContent = match.text.slice(match.start, match.end) || '▏';
  title.append(match.prefix, mark, match.text.slice(match.end));
  row.ariaLabel = `${path}:${match.line}:${match.column} ${match.text}`;
  row.title = `${path}:${match.line}:${match.column}\n${match.text}`;
}

function renderCommit(row: HTMLElement, result: CommitResult, input: string): void {
  row.classList.add('search-result-commit');
  const content = createCommitContent(row);
  renderCommitContent(content, result.snapshot, false);
  if (input) {
    const message = content.$message.title;
    const matches = [...message.matchAll(searchPattern(input))];
    const first = matches[0]?.index ?? 0;
    const start = first ? message.lastIndexOf('\n', first - 1) + 1 : 0;
    const newline = message.indexOf('\n', first);
    const end = newline < 0 ? message.length : newline;
    const positions = matches.flatMap(match => Array.from({ length: match[0].length }, (_, i) => match.index + i))
      .filter(position => start <= position && position < end).map(position => position - start);
    content.$message.replaceChildren();
    appendMatches(content.$message, message.slice(start, end), positions);
  }
}

function appendMatches(parent: HTMLElement, text: string, positions: readonly number[]): void {
  let offset = 0;
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    let end = start + 1;
    while (positions[i + 1] === end) { i++; end++; }
    const mark = $('mark');
    mark.textContent = text.slice(start, end);
    parent.append(text.slice(offset, start), mark);
    offset = end;
  }
  parent.append(text.slice(offset));
}

const labels: Record<Mode, string> = {
  [SearchMode.Files]: 'Go to file', [SearchMode.File]: 'Find in file', [SearchMode.Global]: 'Find in snapshot', [SearchMode.Commits]: 'Find commits',
  [SearchMode.FileSymbols]: 'Go to symbol in file', [SearchMode.WorkspaceSymbols]: 'Go to symbol in snapshot',
  [SearchMode.Definition]: 'Go to definition', [SearchMode.References]: 'Find references', [SearchMode.Related]: 'Find all symbol locations',
  [SearchMode.SymbolLocations]: 'Find symbol location',
};

function isSymbolMode(mode: Mode): mode is SymbolMode {
  return mode !== SearchMode.Files && mode !== SearchMode.File && mode !== SearchMode.Global && mode !== SearchMode.Commits;
}

function isSymbolSearch(state: SearchState): state is SymbolSearch {
  return isSymbolMode(state.mode);
}

function symbolSearchText(location: SymbolLocation, mode: SymbolMode): string {
  if (mode === SearchMode.FileSymbols || mode === SearchMode.WorkspaceSymbols) return location.name;
  return `${location.path}:${location.line}`;
}

function renderSymbol(row: HTMLElement, location: SymbolLocation, mode: SymbolMode, input: string, locations: readonly SymbolLocation[] = [location]): void {
  row.classList.add('search-result-symbol');
  const kind = symbolKinds[location.kind.replace(/^local /, '')] ?? { label: '?', color: 'gray' };
  const tag = appendChild(row, $('.search-symbol-kind'));
  tag.textContent = kind.label;
  tag.dataset.color = kind.color;
  tag.title = location.kind;
  tag.setAttribute('aria-hidden', 'true');
  const content = appendChild(row, $('.search-symbol-content'));
  const text = symbolSearchText(location, mode), positions: number[] = [];
  fuzzyScore(input, text, positions);
  appendMatches(appendChild(content, $('.search-result-title')), text, positions);
  const names = locations
    .map(item => LanguageDescription.matchFilename(languages, item.path)?.name)
    .filter(name => name != null);
  const language = [...new Set(names)].join(',');
  appendChild(row, $('.search-symbol-language')).textContent = language;
  if (mode === SearchMode.WorkspaceSymbols) {
    row.title = `${location.name}\n${language}`;
    row.ariaLabel = `${location.name}, ${location.kind}, ${language}`;
  } else {
    const position = `${location.path}:${location.line}`;
    row.title = `${position}\n${location.preview}`;
    row.ariaLabel = `${location.name}, ${location.kind}, ${position}`;
  }
}

interface SymbolKind {
  readonly label: string;
  readonly color: string;
}

const symbolKinds: Record<string, SymbolKind> = {
  function: { label: 'f', color: 'pink' },
  method: { label: 'm', color: 'pink' },
  constructor: { label: 'c', color: 'pink' },
  call: { label: 'f', color: 'pink' },
  class: { label: 'c', color: 'green' },
  interface: { label: 'i', color: 'green' },
  type: { label: 't', color: 'green' },
  'type parameter': { label: 't', color: 'green' },
  enum: { label: 'e', color: 'green' },
  var: { label: 'v', color: 'blue' },
  let: { label: 'v', color: 'blue' },
  const: { label: 'c', color: 'blue' },
  parameter: { label: 'p', color: 'blue' },
  using: { label: 'v', color: 'blue' },
  'await using': { label: 'v', color: 'blue' },
  property: { label: 'p', color: 'gold' },
  getter: { label: 'g', color: 'gold' },
  setter: { label: 's', color: 'gold' },
  accessor: { label: 'p', color: 'gold' },
  'enum member': { label: 'e', color: 'gold' },
  module: { label: 'n', color: 'purple' },
  alias: { label: 'a', color: 'purple' },
  script: { label: 's', color: 'purple' },
  reference: { label: 'r', color: 'gray' },
  write: { label: 'w', color: 'blue' },
};

const symbolActions: Record<Exclude<SymbolMode, SearchMode.WorkspaceSymbols | SearchMode.SymbolLocations>, SymbolAction> = {
  [SearchMode.FileSymbols]: SymbolAction.FileSymbols,
  [SearchMode.Definition]: SymbolAction.Definition,
  [SearchMode.References]: SymbolAction.References,
  [SearchMode.Related]: SymbolAction.Related,
};
