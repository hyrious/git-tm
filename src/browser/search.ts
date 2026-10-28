import type { Snapshot } from '../common/git';
import type { Writable } from '../common/base';
import type { TextMatch } from './search-match';

import { appendChild, listen } from '@wopjs/dom';
import { $, onCustomEvent } from './dom';
import { fuzzyScore, searchPattern, textLines, textMatches } from './search-match';
import { Widget } from './widget';
import { Scrollbars } from './scrollbars';
import { createCommitContent, renderCommitContent } from './commit-content';
import { bindKeys } from './keybindings';

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

interface FileSearch {
  readonly mode: 'files';
  readonly results: FileResult[];
}

interface TextSearch {
  readonly mode: 'file' | 'global';
  readonly results: TextResult[];
  previewed: boolean;
}

interface CommitSearch {
  readonly mode: 'commits';
  readonly results: CommitResult[];
}

type SearchState = FileSearch | TextSearch | CommitSearch;
type Mode = SearchState['mode'];

interface SearchMemory {
  readonly input: string;
  readonly selected: number;
  readonly path: string | undefined;
}

const limit = 200;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export class Search extends Widget {
  readonly $dialog: HTMLDialogElement;
  readonly $input: HTMLInputElement;
  readonly $list: HTMLElement;
  readonly $note: HTMLElement;
  readonly scrollbars: Scrollbars;
  readonly memory = new Map<'file' | 'global', SearchMemory>();

  state: SearchState = createState('files');
  generation = 0;
  selected = 0;
  restore: (() => void) | undefined;

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
    this._register(() => this.generation++);

    this._register(bindKeys(window, {
      'Mod+f': { when: () => this.root.editor.editor != null, run: () => this.toggle('file') },
      'Mod+Shift+f': () => this.toggle('global'),
      'Mod+p': () => this.toggle('files'),
      'Mod+k': () => this.toggle('commits'),
    }));
    this._register(listen(this.$input, 'input', e => {
      if (!(e as InputEvent).isComposing) this.run();
    }));
    this._register(listen(this.$input, 'compositionstart', () => {
      this.generation++;
      this.state = createState(this.state.mode);
      this.selected = 0;
      this.render();
      this.scrollbars.reset();
      this.$note.textContent = '';
    }));
    this._register(listen(this.$input, 'compositionend', () => this.run()));
    this._register(bindKeys(this.$dialog, {
      'ArrowDown,ArrowUp': { repeat: true, run: e => this.onArrowKey(e) },
      'Enter': () => this.accept(),
    }));
    this._register(listen(this.$dialog, 'cancel', e => { e.preventDefault(); this.close(); }));
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
      this.close();
      this.memory.clear();
    }));
    this._register(onCustomEvent('editor.clear', () => {
      if (this.state.mode === 'file') this.close();
    }));
  }

  onArrowKey(e: KeyboardEvent): void {
    if (this.state.results.length) this.select((this.selected + (e.key === 'ArrowDown' ? 1 : -1) + this.state.results.length) % this.state.results.length);
  }

  toggle(mode: Mode): void {
    if (this.$dialog.open && this.state.mode === mode) {
      this.close();
      return;
    }
    this.close();
    this.state = createState(mode);
    const memory = mode === 'file' || mode === 'global' ? this.memory.get(mode) : undefined;
    const view = this.root.editor.editor;
    if (mode === 'file' && view) {
      const selection = view.state.selection, scroll = view.scrollSnapshot();
      this.restore = () => {
        if (this.root.editor.editor === view) view.dispatch({ selection, effects: scroll });
      };
    }
    const label = mode === 'commits' ? 'Find commits' : mode === 'files' ? 'Go to file' : mode === 'file' ? 'Find in file' : 'Find in snapshot';
    this.$dialog.ariaLabel = label;
    this.$input.ariaLabel = label;
    this.$input.placeholder = mode === 'files' ? 'Search files by name…' : `${label}: text or /pattern/`;
    this.$input.value = memory?.input ?? (mode === 'file' && view
      ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : '');
    this.$dialog.showModal();
    this.$input.focus();
    this.$input.select();
    this.run(memory && (mode === 'global' || memory.path === this.root.editor.path) ? memory.selected : 0);
  }

  close(restore = true): void {
    if (!this.$dialog.open) return;
    if (this.state.mode === 'file' || this.state.mode === 'global') {
      this.memory.set(this.state.mode, {
        input: this.$input.value,
        selected: this.selected,
        path: this.root.editor.path,
      });
    }
    this.generation++;
    if (this.state.mode === 'file') this.root.editor.highlight([]);
    if (restore) this.restore?.();
    this.restore = undefined;
    this.scrollbars.reset();
    this.$dialog.close();
  }

  run(selected = 0): void {
    const generation = ++this.generation;
    this.state = createState(this.state.mode);
    this.selected = selected;
    this.render();
    this.$list.scrollTop = 0;
    this.scrollbars.reset();
    this.$note.textContent = '';
    this.$input.removeAttribute('aria-invalid');
    if (this.state.mode === 'file') this.root.editor.highlight([]);
    this.search(generation).catch(error => {
      if (generation === this.generation) {
        this.$note.textContent = error instanceof SyntaxError ? 'Invalid regular expression.' : 'Could not complete search.';
        this.$input.setAttribute('aria-invalid', String(error instanceof SyntaxError));
      }
    });
  }

  async search(generation: number): Promise<void> {
    const state = this.state, input = this.$input.value;
    if ((state.mode === 'file' || state.mode === 'global') && !input) return;
    if (state.mode !== 'commits' && !this.root.git.snapshot$.value) {
      this.$note.textContent = 'No snapshot selected.';
      return;
    }
    this.$note.textContent = 'Searching…';
    let skipped = 0;
    switch (state.mode) {
      case 'files': await this.searchFiles(state, input, generation); break;
      case 'file':
      case 'global': skipped = await this.searchText(state, input, generation); break;
      case 'commits': await this.searchCommits(state, input, generation); break;
    }
    if (generation !== this.generation) return;
    this.selected = Math.min(this.selected, Math.max(0, state.results.length - 1));
    this.publish(state);
    this.$list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
    const count = state.results.length;
    this.$note.textContent = count >= limit ? `Showing the first ${limit} results.`
      : count ? `${count} results` : 'No results.';
    if (skipped) this.$note.textContent += ` ${skipped} files could not be read.`;
  }

  async searchFiles(state: FileSearch, input: string, generation: number): Promise<void> {
    const snapshot = this.root.git.snapshot$.value;
    if (!snapshot) return;
    const paths = await this.root.git.paths(snapshot);
    if (generation !== this.generation) return;
    let deadline = performance.now() + 8;
    for (const path of paths) {
      const score = fuzzyScore(input, path);
      if (score !== -Infinity) state.results.push({ path, score });
      if (performance.now() >= deadline) {
        this.publish(state);
        await pause();
        if (generation !== this.generation) return;
        deadline = performance.now() + 8;
      }
    }
  }

  async searchText(state: TextSearch, input: string, generation: number): Promise<number> {
    const pattern = searchPattern(input);
    const snapshot = this.root.git.snapshot$.value;
    const view = this.root.editor.editor;
    if (!snapshot) return 0;
    const paths = state.mode === 'file' ? [this.root.editor.path ?? ''] : await this.root.git.paths(snapshot);
    if (generation !== this.generation) return 0;
    let deadline = performance.now() + 8, skipped = 0;
    for (const path of paths) {
      if (generation !== this.generation) return skipped;
      let lines: Iterable<string>;
      if (state.mode === 'file') {
        if (!view || view !== this.root.editor.editor) return skipped;
        lines = view.state.doc.iterLines();
      } else {
        let bytes: Uint8Array;
        try { bytes = await this.root.git.blob(path, snapshot); }
        catch { skipped++; continue; }
        if (generation !== this.generation) return skipped;
        if (bytes.subarray(0, 8000).includes(0)) continue;
        lines = textLines(new TextDecoder().decode(bytes));
      }
      for (const match of textMatches(lines, pattern)) {
        if (match) state.results.push({ path, match });
        if (state.results.length >= limit) return skipped;
        if (performance.now() >= deadline) {
          this.publish(state);
          await pause();
          if (generation !== this.generation) return skipped;
          deadline = performance.now() + 8;
        }
      }
    }
    return skipped;
  }

  async searchCommits(state: CommitSearch, input: string, generation: number): Promise<void> {
    const pattern = input ? searchPattern(input) : undefined;
    const git = this.root.git;
    let deadline = performance.now() + 8;
    for (let index = 0; index < git.history.length; index++) {
      if (generation !== this.generation) return;
      if (git.history[index] == null) {
        this.publish(state);
        await git.touch(index + 1);
        if (generation !== this.generation) return;
      }
      const snapshot = git.history[index];
      if (pattern) pattern.lastIndex = 0;
      if (snapshot && (!pattern || pattern.test(snapshot.kind === 'working-tree' ? 'Working Directory' : snapshot.message))) {
        state.results.push({ snapshot, index });
        if (state.results.length >= limit) return;
      }
      if (performance.now() >= deadline) {
        this.publish(state);
        await pause();
        if (generation !== this.generation) return;
        deadline = performance.now() + 8;
      }
    }
  }

  publish(state: SearchState): void {
    this.scrollbars.update();
    if (state.mode === 'files') {
      state.results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      state.results.length = Math.min(state.results.length, limit);
      this.selected = 0;
    }
    this.render();
    if (state.mode === 'files') {
      this.$list.scrollTop = 0;
      this.scrollbars.reset();
    } else {
      this.scrollbars.update(true);
    }
    if (state.mode === 'file') {
      this.root.editor.highlight(state.results.map(result => result.match));
      if (!state.previewed && state.results.length > this.selected) {
        state.previewed = true;
        this.select(this.selected);
      }
    }
  }

  render(): void {
    const state = this.state;
    switch (state.mode) {
      case 'files': this.renderResults(state.results, (row, result) => renderFile(row, result, this.$input.value)); break;
      case 'file':
      case 'global': this.renderResults(state.results, renderText); break;
      case 'commits': this.renderResults(state.results, renderCommit); break;
    }
    if (state.results.length) this.$input.setAttribute('aria-activedescendant', `search-result-${this.selected}`);
    else this.$input.removeAttribute('aria-activedescendant');
  }

  renderResults<T>(results: readonly T[], render: (row: HTMLElement, result: T) => void): void {
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

  select(index: number): void {
    this.selected = index;
    for (const row of this.$list.children) row.ariaSelected = String((row as HTMLElement).dataset.index === String(index));
    this.$input.setAttribute('aria-activedescendant', `search-result-${index}`);
    this.$list.children[index]?.scrollIntoView({ block: 'nearest' });
    const state = this.state;
    if (state.mode === 'file') {
      const match = state.results[index]?.match;
      if (match) this.root.editor.reveal(match.from, match.to);
    }
  }

  accept(): void {
    const state = this.state, index = this.selected;
    if (!state.results[index]) return;
    this.close(false);
    switch (state.mode) {
      case 'commits': this.root.commits.accept(state.results[index].index); break;
      case 'file': {
        const { match } = state.results[index];
        this.root.editor.reveal(match.from, match.to);
        this.root.editor.focus();
        break;
      }
      case 'files':
      case 'global': {
        const match = state.mode === 'global' ? state.results[index].match : undefined;
        window.dispatchEvent(new CustomEvent('editor.open', {
          detail: { path: state.results[index].path, from: match?.from ?? 0, to: match?.to ?? 0 }
        }));
        break;
      }
    }
  }

  override layout(): void { }
}

function createState(mode: Mode): SearchState {
  switch (mode) {
    case 'files': return { mode, results: [] };
    case 'file':
    case 'global': return { mode, results: [], previewed: false };
    case 'commits': return { mode, results: [] };
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

function renderCommit(row: HTMLElement, result: CommitResult): void {
  row.classList.add('search-result-commit');
  renderCommitContent(createCommitContent(row), result.snapshot, false);
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
