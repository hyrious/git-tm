import type { Writable } from '../common/base';
import type { DiffFile, DiffRange, Snapshot } from '../common/git';

import { seq } from '@wopjs/async-seq';
import { appendChild, listen } from '@wopjs/dom';
import { writable } from '@embra/reactivity';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { unifiedMergeView } from '@codemirror/merge';
import { $, onCustomEvent } from './dom';
import { modernDark, modernLight } from './editor-theme';
import { Widget } from './widget';
import { Scrollbars } from './scrollbars';
import { bindKeys } from './keybindings';

export interface DiffTarget {
  readonly kind: 'diff';
  readonly snapshot: Snapshot;
  readonly range: DiffRange;
  readonly file: DiffFile;
}

interface FileTarget {
  readonly kind: 'file';
  readonly snapshot: Snapshot;
  readonly path: string;
  readonly location?: FileLocation;
}

export interface FileLocation {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

type EditorTarget = FileTarget | DiffTarget;

export class Editor extends Widget {
  readonly $header: HTMLElement;
  readonly $body: HTMLElement;
  view: EditorView | undefined;
  path: string | undefined;
  readonly matches = new Compartment();
  readonly theme = new Compartment();
  readonly colorScheme = matchMedia('(prefers-color-scheme: dark)');

  override initialize(this: Writable<this>): void {
    this.$header = appendChild(this.parent, $('.editors-header'));
    this.$body = appendChild(this.parent, $('.editor-body'));
    this.$body.tabIndex = -1;
    this.showMessage('Select a file to view its contents.');
    this._register(() => this.view?.destroy());
    this._register(listen(this.colorScheme, 'change', () => {
      this.view?.dispatch({ effects: this.theme.reconfigure(this.colorScheme.matches ? modernDark : modernLight) });
    }));
    this._register(bindKeys(this.$body, {
      'Escape'() { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); },
    }));

    const target$ = this._register(writable<EditorTarget | undefined>(undefined));
    const queue = this._register(seq({ window: 1, dropHead: true }));
    this._register(onCustomEvent<string | FileLocation>('editor.open', e => {
      const snapshot = this.root.git.snapshot$.value;
      if (snapshot) target$.set({
        kind: 'file', snapshot,
        path: typeof e.detail === 'string' ? e.detail : e.detail.path,
        location: typeof e.detail === 'string' ? undefined : e.detail
      });
    }));
    this._register(onCustomEvent<DiffTarget>('editor.diff', e => {
      if (e.detail.snapshot === this.root.git.snapshot$.value) target$.set(e.detail);
    }));
    this._register(this.root.git.snapshot$.subscribe(snapshot => {
      const target = target$.value;
      if (target?.snapshot !== snapshot) {
        target$.set(target?.kind === 'file' && snapshot ? { ...target, snapshot, location: undefined } : undefined);
      }
    }));
    this._register(target$.subscribe(target => {
      const path = target?.kind === 'diff' ? target.file.newPath : target?.path;
      this.root.setTitle(path?.split('/').pop());
      this.$header.textContent = target?.kind === 'diff' ? `${target.file.oldPath} → ${path}` : path ?? null;
      this.$header.title = this.$header.textContent ?? '';
      this.showMessage(target ? 'Loading…' : 'Select a file to view its contents.');
      queue.schedule(async () => {
        if (!target) return;
        try {
          const contents = target.kind === 'diff'
            ? await this.root.git.diffContents(target.range, target.file)
            : [await this.root.git.blob(target.path, target.snapshot)];
          if (target$.disposed || target$.value !== target) return;
          if ((target.kind === 'diff' && target.file.insertions == null) || contents.some(b => b.subarray(0, 8000).includes(0))) {
            this.showMessage('File is binary.');
            return;
          }
          const decoder = new TextDecoder();
          const docs = contents.map(b => decoder.decode(b));
          const focused = this.$body.contains(document.activeElement);
          this.clear();
          if (target.kind === 'diff') {
            this.view = new EditorView({
              parent: this.$body,
              doc: docs[1],
              extensions: [
                this.extensions(target.file.newPath, `${target.file.newPath} (diff)`),
                unifiedMergeView({ original: docs[0], mergeControls: false }),
              ],
            });
          } else {
            this.view = new EditorView({ parent: this.$body, doc: docs[0], extensions: this.extensions(target.path, target.path) });
          }
          this.path = path;
          if (target.kind === 'file' && target.location) {
            this.reveal(target.location.from, target.location.to);
            this.focus();
          } else if (focused) this.focus();
        } catch (error) {
          if (!target$.disposed && target$.value === target) this.showMessage(target.kind === 'diff' ? 'Could not read diff.' : 'Could not read file.');
        }
      });
    }));
  }

  extensions(path: string, label: string): Extension {
    const language = new Compartment();
    const description = LanguageDescription.matchFilename(languages, path);
    return [
      EditorState.readOnly.of(true),
      EditorState.tabSize.of(4),
      EditorView.contentAttributes.of({ 'aria-label': label }),
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
      bracketMatching(), foldGutter({ openText: '\uEAB4', closedText: '\uEAB6' }), this.matches.of([]),
      keymap.of([...defaultKeymap, ...foldKeymap]),
      this.theme.of(this.colorScheme.matches ? modernDark : modernLight),
      ViewPlugin.define(view => {
        const scrollbars = new Scrollbars(view.scrollDOM, view.contentDOM);
        return { destroy() { scrollbars.dispose(); } };
      }),
      language.of(description?.support ?? []),
      ViewPlugin.define(view => {
        let active = true;
        if (description) description.load().then(support => {
          if (active) view.dispatch({ effects: language.reconfigure(support) });
        }).catch(console.error);
        return { destroy() { active = false; } };
      }),
    ];
  }

  clear(): void {
    window.dispatchEvent(new CustomEvent('editor.clear'));
    this.view?.destroy();
    this.view = undefined;
    this.path = undefined;
    this.$body.replaceChildren();
    this.$body.classList.remove('editor-message');
  }

  showMessage(message: string): void {
    const focused = this.$body.contains(document.activeElement);
    this.clear();
    this.$body.classList.add('editor-message');
    this.$body.textContent = message;
    if (focused) this.focus();
  }

  focus(): void {
    if (this.view) this.view.focus();
    else this.$body.focus({ preventScroll: true });
  }

  reveal(from: number, to: number): void {
    const view = this.view;
    if (!view) return;
    from = Math.min(from, view.state.doc.length);
    to = Math.min(to, view.state.doc.length);
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  }

  highlight(matches: readonly { from: number; to: number; }[]): void {
    const marks = matches.filter(match => match.from < match.to).map(match =>
      Decoration.mark({ class: 'cm-searchMatch' }).range(match.from, match.to));
    this.view?.dispatch({ effects: this.matches.reconfigure(EditorView.decorations.of(Decoration.set(marks, true))) });
  }

  override layout(): void {
    this.view?.requestMeasure();
  }
}
