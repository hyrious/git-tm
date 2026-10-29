import type { FileReference, FileLocation, FileContents } from '../common/symbols';
import type { Writable } from '../common/base';
import type { DiffFile, DiffRange, Snapshot } from '../common/git';

import { writable } from '@embra/reactivity';
import { appendChild, listen } from '@wopjs/dom';
import { Compartment, EditorState, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { unifiedMergeView } from '@codemirror/merge';
import { FileSource } from '../common/symbols';
import { SnapshotKind, snapshotId } from '../common/git';
import { $, onCustomEvent } from './dom';
import { modernDark, modernLight } from './editor-theme';
import { Widget } from './widget';
import { Scrollbars } from './scrollbars';
import { bindKeys } from './keybindings';
import { ImagePreview, imageType } from './image-preview';
import { NavigationHistory, formatLocation, parseLocation, positionAt, offsetAt, type NavigationEntry } from './navigation';

export const enum EditorTargetKind {
  File,
  Diff,
}

export interface DiffTarget {
  readonly kind: EditorTargetKind.Diff;
  readonly snapshot: Snapshot;
  readonly range: DiffRange;
  readonly file: DiffFile;
  readonly restore?: NavigationEntry;
  readonly record?: boolean;
}

interface EditorDocument {
  readonly file: FileReference;
  readonly snapshot: Snapshot;
  readonly version: string;
}

interface FileTarget {
  readonly kind: EditorTargetKind.File;
  readonly source: FileSource;
  readonly snapshot: Snapshot;
  readonly path: string;
  readonly location?: FileLocation;
  readonly restore?: NavigationEntry;
  readonly record: boolean;
}

interface SavedEditor {
  readonly state: EditorState;
  readonly document: EditorDocument | undefined;
  readonly scroll: StateEffect<unknown>;
}

type EditorTarget = (FileTarget | DiffTarget) & {
  readonly preview?: boolean;
  readonly saved?: SavedEditor;
};

interface EditorPreview {
  readonly target: EditorTarget | undefined;
  readonly origin: NavigationEntry | undefined;
  readonly files: Map<string, Promise<FileContents>>;
}

export class Editor extends Widget {
  readonly $header: HTMLElement;
  readonly $body: HTMLElement;

  readonly matches = new Compartment();
  readonly theme = new Compartment();
  readonly colorScheme = matchMedia('(prefers-color-scheme: dark)');
  readonly navigation$ = this._register(writable({ back: false, forward: false }));

  readonly history = new NavigationHistory();
  readonly target$ = this._register(writable<EditorTarget | undefined>(undefined));
  navigationRequest = 0;
  urlRequest = 0;
  changingSnapshot = false;
  restoring = false;
  previewing = false;
  previewSession: EditorPreview | undefined;

  displayedTarget: EditorTarget | undefined;
  path: string | undefined;
  document: EditorDocument | undefined;
  editor: EditorView | undefined;
  image: ImagePreview | undefined;

  override initialize(this: Writable<this>): void {
    this.$header = appendChild(this.parent, $('.editors-header'));
    this.$body = appendChild(this.parent, $('.editor-body'));
    this.$body.tabIndex = -1;
    this.showMessage('Select a file to view its contents.');
    this._register(() => this.editor?.destroy());
    this._register(() => this.image?.dispose());
    this._register(listen(this.colorScheme, 'change', () => {
      this.editor?.dispatch({ effects: this.theme.reconfigure(this.colorScheme.matches ? modernDark : modernLight) });
    }));
    this._register(bindKeys(this.$body, {
      'Escape'() { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); },
    }));

    const target$ = this.target$;
    this._register(onCustomEvent<string | FileLocation>('editor.open', e => {
      this.remember(true);
      this.history.leave();
      this.updateNavigation();
      this.openFile(e.detail, false);
    }));
    this._register(onCustomEvent<DiffTarget>('editor.diff', e => {
      if (e.detail.snapshot === this.root.git.snapshot$.value) {
        this.remember(true);
        this.history.leave();
        this.updateNavigation();
        target$.set({ ...e.detail, record: true });
      }
    }));
    this._register(this.root.git.snapshot$.subscribe(snapshot => {
      if (this.changingSnapshot) return;
      this.navigationRequest++;
      const target = target$.value;
      if (target?.snapshot !== snapshot) {
        this.remember(false);
        this.history.leave();
        this.updateNavigation();
        if (target?.kind === EditorTargetKind.File && snapshot) {
          target$.set({
            ...target, snapshot, location: undefined, restore: undefined,
            saved: undefined, preview: false, record: false,
          });
        } else {
          target$.set(undefined);
        }
      }
    }));
    this._register(target$.subscribe(target => {
      const request = ++this.navigationRequest;
      this.urlRequest++;
      const path = target?.kind === EditorTargetKind.Diff ? target.file.newPath : target?.path;
      if (!target) {
        this.setHeader(undefined);
        this.showMessage('Select a file to view its contents.');
        return;
      }
      if (target.kind === EditorTargetKind.File && target.source === FileSource.Snapshot && !target.preview) {
        this.root.files.reveal(target.path);
      }
      if (target.saved) {
        this.clear();
        this.setHeader(target);
        this.editor = new EditorView({ parent: this.$body, state: target.saved.state });
        this.document = target.saved.document;
        this.path = path;
        this.restoring = true;
        this.editor.dispatch({ effects: target.saved.scroll });
        this.restoring = false;
        if (!this.previewing) this.focus();
        return;
      }
      void (async () => {
        try {
          const file = target.kind === EditorTargetKind.File ? await this.contents(target) : undefined;
          const contents = target.kind === EditorTargetKind.Diff
            ? await this.root.git.diffContents(target.range, target.file)
            : [file!.bytes];
          if (target$.disposed || request !== this.navigationRequest) return;
          this.setHeader(target);
          const mime = target.kind === EditorTargetKind.File ? imageType(target.path) : undefined;
          if (target.kind === EditorTargetKind.File && mime) {
            const focused = this.$body.contains(document.activeElement);
            this.clear();
            this.image = new ImagePreview(this.$body, this.root.status.$image, contents[0], mime, target.path, () => this.showMessage('Could not load image.'));
            this.path = path;
            if (!target.preview) this.writeURL('');
            if (focused) this.focus();
            return;
          }
          const binaryDiff = target.kind === EditorTargetKind.Diff && target.file.insertions == null;
          const binaryContents = contents.some(bytes => bytes.subarray(0, 8000).includes(0));
          if (binaryDiff || binaryContents) {
            this.showMessage('File is binary.');
            if (!target.preview) {
              if (target.kind === EditorTargetKind.Diff) {
                this.remember(target.record ?? false);
                this.updateURL();
              } else {
                this.writeURL('');
              }
            }
            return;
          }
          const decoder = new TextDecoder();
          const docs = contents.map(b => decoder.decode(b));
          const focused = this.$body.contains(document.activeElement);
          this.clear();
          if (target.kind === EditorTargetKind.Diff) {
            this.editor = new EditorView({
              parent: this.$body,
              doc: docs[1],
              extensions: [
                this.extensions(target.file.newPath, `${target.file.newPath} (diff)`),
                unifiedMergeView({ original: docs[0], mergeControls: false, collapseUnchanged: { margin: 5 } }),
              ],
            });
          } else {
            this.editor = new EditorView({ parent: this.$body, doc: docs[0], extensions: this.extensions(target.path, target.path) });
            this.document = { file: { source: target.source, path: target.path }, snapshot: target.snapshot, version: file!.version };
          }
          this.path = path;
          this.restoring = true;
          if (target.kind === EditorTargetKind.File && target.location) {
            if (!target.location.version || target.location.version === file!.version) this.reveal(target.location.from, target.location.to);
            else this.$header.textContent = `${target.path} — File changed; run the symbol command again.`;
            if (!target.preview) this.focus();
          } else if (focused) this.focus();
          if (target.restore) {
            this.restoreSelection(target.restore);
            this.focus();
          }
          this.restoring = false;
          if (target.preview) return;
          this.remember(target.record ?? false);
          this.updateURL();
        } catch (error) {
          this.restoring = false;
          if (!target$.disposed && request === this.navigationRequest) {
            this.setHeader(target);
            this.showMessage(target.kind === EditorTargetKind.Diff ? 'Could not read diff.' : 'Could not read file.');
          }
        }
      })();
    }));
    this._register(listen(window, 'hashchange', () => this.openURL()));
    this.openURL();
  }

  openFile(_location: string | FileLocation, preview: boolean): void {
    const snapshot = this.root.git.snapshot$.value;
    if (!snapshot) return;
    let location: FileLocation | undefined, source: FileSource, path: string;
    if (typeof _location === 'string') {
      source = FileSource.Snapshot;
      path = _location;
    } else {
      location = _location;
      source = _location.source;
      path = _location.path;
    }
    const document = this.document;
    if (preview && this.editor && document?.snapshot === snapshot && document.file.source === source && document.file.path === path
      && (!location || !location.version || location.version === document.version)) {
      if (location) this.reveal(location.from, location.to);
      return;
    }
    this.target$.set({
      kind: EditorTargetKind.File, snapshot, source, path,
      location: location,
      record: !preview, preview,
    });
  }

  canCompare(): boolean {
    const target = this.target$.value;
    return target?.kind === EditorTargetKind.File && target.source === FileSource.Snapshot
      && target === this.displayedTarget && this.editor != null;
  }

  compare(base: Snapshot): void {
    const target = this.target$.value;
    if (!this.canCompare() || target?.kind !== EditorTargetKind.File || base.kind !== SnapshotKind.Commit) return;
    if (snapshotId(base) === snapshotId(target.snapshot)) return;
    const { path, snapshot } = target;
    void (async () => {
      try {
        const exists = (await this.root.git.paths(base)).includes(path);
        if (this.target$.disposed || this.target$.value !== target) return;
        window.dispatchEvent(new CustomEvent<DiffTarget>('editor.diff', {
          detail: {
            kind: EditorTargetKind.Diff, snapshot,
            range: { base: base.hash, target: snapshot.kind === SnapshotKind.Commit ? snapshot.hash : undefined },
            file: { status: exists ? 'M' : 'A', oldPath: path, newPath: path, insertions: 0, deletions: 0 },
          }
        }));
        this.focus();
      } catch {
        if (!this.target$.disposed && this.target$.value === target) this.showMessage('Could not read diff.');
      }
    })();
  }

  contents(target: FileTarget & { readonly preview?: boolean; }): Promise<FileContents> {
    const files = target.preview ? this.previewSession?.files : undefined;
    if (!files) return this.root.git.contents(target, target.snapshot);
    const key = `${target.source}:${target.path}`;
    let result = files.get(key);
    if (!result) {
      result = this.root.git.contents(target, target.snapshot);
      files.set(key, result);
    }
    return result;
  }

  beginPreview(): NavigationEntry | undefined {
    const target = this.displayedTarget, view = this.editor;
    const origin = this.capture();
    let savedTarget = target;
    if (target && view) {
      savedTarget = {
        ...target,
        saved: { state: view.state, document: this.document, scroll: view.scrollSnapshot() },
      };
    }
    this.previewSession = { target: savedTarget, origin, files: new Map() };
    this.previewing = true;
    this.urlRequest++;
    return origin;
  }

  endPreview(restore: boolean, location?: string | FileLocation): void {
    const session = this.previewSession;
    this.previewSession = undefined;
    this.previewing = false;
    if (!session) return;
    if (location != null) {
      if (session.origin) this.history.visit(session.origin);
      this.history.leave();
      this.updateNavigation();
      this.openFile(location, false);
    } else if (restore && (!session.target || session.target.snapshot === this.root.git.snapshot$.value)) {
      this.target$.set(session.target ? { ...session.target } : undefined);
    }
  }

  resetPreview(): void {
    const session = this.previewSession;
    if (session && (!session.target || session.target.snapshot === this.root.git.snapshot$.value)) {
      this.target$.set(session.target ? { ...session.target, preview: true } : undefined);
    }
  }

  capture(): NavigationEntry | undefined {
    const document = this.document, editor = this.editor;
    const target = this.displayedTarget;
    if (target?.kind === EditorTargetKind.Diff) {
      let anchor = { line: 1, column: 1 }, head = { line: 1, column: 1 };
      if (editor) {
        const selection = editor.state.selection.main;
        anchor = positionAt(editor.state.doc, selection.anchor);
        head = positionAt(editor.state.doc, selection.head);
      }
      return {
        location: {
          source: FileSource.Snapshot,
          path: target.file.newPath,
          snapshot: snapshotId(target.snapshot),
          anchor, head,
          diff: {
            base: target.range.base,
            oldPath: target.file.oldPath,
            status: target.file.status[0],
            binary: target.file.insertions == null,
          },
        },
        saved: undefined,
      };
    }
    if (!document || !editor) return;
    const { anchor, head } = editor.state.selection.main;
    return {
      location: {
        ...document.file, snapshot: snapshotId(document.snapshot),
        anchor: positionAt(editor.state.doc, anchor), head: positionAt(editor.state.doc, head),
      },
      saved: { version: document.version, selection: { anchor, head }, scroll: editor.scrollSnapshot() },
    };
  }

  remember(visit: boolean): void {
    if (this.previewing || this.restoring) return;
    const entry = this.capture();
    if (entry) {
      if (visit) this.history.visit(entry);
      else this.history.update(entry);
    }
    this.updateNavigation();
  }

  updateNavigation(): void {
    this.navigation$.set({ back: this.history.canGoBack, forward: this.history.canGoForward });
  }

  jump(from: number, to: number, origin?: NavigationEntry): void {
    if (origin) this.history.visit(origin);
    else this.remember(true);
    this.restoring = true;
    this.reveal(from, to);
    this.restoring = false;
    this.remember(true);
    this.updateURL();
    this.focus();
  }

  go(direction: -1 | 1): void {
    this.remember(false);
    const entry = this.history.go(direction);
    if (entry) void this.restoreLocation(entry, false);
    this.updateNavigation();
  }

  openURL(): void {
    if (!location.hash) return;
    const entry = parseLocation(location.hash);
    if (entry) {
      this.remember(true);
      void this.restoreLocation({ location: entry, saved: undefined }, true);
    } else {
      this.remember(false);
      this.history.leave();
      this.target$.set(undefined);
      this.showMessage('Invalid file location.');
      this.updateNavigation();
    }
  }

  async restoreLocation(entry: NavigationEntry, record: boolean): Promise<void> {
    const location = entry.location;
    this.urlRequest++;
    const request = ++this.navigationRequest;
    try {
      let id = location.snapshot;
      if (id !== 'working-tree') {
        id = (await this.root.git.resolveRevision(id)).hash;
      }
      if (request !== this.navigationRequest || this.target$.disposed) return;
      let base = location.diff?.base;
      if (base && !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(base)) {
        base = (await this.root.git.resolveRevision(base)).hash;
      }
      if (request !== this.navigationRequest || this.target$.disposed) return;
      const index = await this.root.git.findSnapshot(id);
      if (request !== this.navigationRequest || this.target$.disposed) return;
      if (index == null) throw new Error('Snapshot is no longer available.');
      this.changingSnapshot = true;
      this.root.commits.offset$.set(undefined);
      window.dispatchEvent(new CustomEvent('pinned', { detail: false }));
      this.root.git.index$.set(index);
      this.changingSnapshot = false;
      window.dispatchEvent(new CustomEvent('scroll-to', { detail: index }));
      const snapshot = this.root.git.snapshot$.value!;
      if (location.diff) {
        const { oldPath, status, binary } = location.diff;
        this.target$.set({
          kind: EditorTargetKind.Diff, snapshot,
          range: { base: base!, target: snapshot.kind === SnapshotKind.Commit ? snapshot.hash : undefined },
          file: { status, oldPath, newPath: location.path, insertions: binary ? null : 0, deletions: binary ? null : 0 },
          restore: entry, record,
        });
      } else {
        this.target$.set({
          kind: EditorTargetKind.File, snapshot,
          source: location.source, path: location.path,
          restore: entry, record,
        });
      }
    } catch (error) {
      if (request === this.navigationRequest && !this.target$.disposed) {
        this.history.leave();
        this.updateNavigation();
        this.showMessage(error instanceof Error ? error.message : 'Could not restore location.');
      }
    } finally {
      this.changingSnapshot = false;
    }
  }

  restoreSelection(entry: NavigationEntry): void {
    const { location, saved } = entry;
    const editor = this.editor;
    if (!editor) return;
    if (saved && saved.version === this.document?.version) editor.dispatch({ selection: saved.selection, effects: saved.scroll });
    else this.reveal(offsetAt(editor.state.doc, location.anchor), offsetAt(editor.state.doc, location.head));
  }

  updateURL(): void {
    if (this.previewing || this.restoring) return;
    const location = this.capture()?.location;
    if (!location) return;
    const request = ++this.urlRequest;
    const shorten = (ref: string) => this.root.git.resolveRevision(ref).then(revision => revision.shortHash).catch(() => ref);
    void Promise.all([
      location.snapshot === 'working-tree' ? location.snapshot : shorten(location.snapshot),
      location.diff ? shorten(location.diff.base) : undefined,
    ]).then(([snapshot, base]) => {
      if (request === this.urlRequest && !this.target$.disposed) {
        this.writeURL(formatLocation({
          ...location, snapshot,
          diff: location.diff ? { ...location.diff, base: base! } : undefined,
        }));
      }
    });
  }

  writeURL(hash: string): void {
    if (location.hash !== hash) window.history.replaceState(null, '', location.pathname + location.search + hash);
  }

  async refreshFile(): Promise<void> {
    const document = this.document, editor = this.editor;
    if (!document || !editor) return;
    const contents = await this.root.git.contents(document.file, document.snapshot);
    if (this.document !== document || this.editor !== editor) return;
    const text = new TextDecoder().decode(contents.bytes);
    this.document = { ...document, version: contents.version };
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  }

  extensions(path: string, label: string): Extension {
    const language = new Compartment();
    const description = LanguageDescription.matchFilename(languages, path);
    return [
      EditorState.readOnly.of(true),
      EditorState.tabSize.of(4),
      EditorView.editorAttributes.of({ class: 'scrollbar-host' }),
      EditorView.contentAttributes.of({ 'aria-label': label }),
      EditorView.updateListener.of(update => {
        if (update.selectionSet || update.docChanged) {
          this.remember(false);
          this.updateURL();
        }
      }),
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

  setHeader(target: EditorTarget | undefined): void {
    this.displayedTarget = target;
    const path = target?.kind === EditorTargetKind.Diff ? target.file.newPath : target?.path;
    this.root.setTitle(path?.split('/').pop());
    if (target?.kind === EditorTargetKind.Diff) {
      const base = target.range.base.slice(0, 7);
      const revision = target.range.target?.slice(0, 7) ?? 'Working Directory';
      this.$header.textContent = `${target.file.oldPath} → ${path} — ${base} → ${revision}`;
    } else {
      this.$header.textContent = path ?? null;
    }
    this.$header.title = this.$header.textContent ?? '';
  }

  clear(): void {
    this.urlRequest++;
    window.dispatchEvent(new CustomEvent('editor.clear'));
    this.editor?.destroy();
    this.editor = undefined;
    this.image?.dispose();
    this.image = undefined;
    this.path = undefined;
    this.document = undefined;
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
    if (this.editor) this.editor.focus();
    else this.$body.focus({ preventScroll: true });
  }

  reveal(from: number, to: number): void {
    const editor = this.editor;
    if (!editor) return;
    from = Math.min(from, editor.state.doc.length);
    to = Math.min(to, editor.state.doc.length);
    editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  }

  highlight(matches: readonly { from: number; to: number; }[]): void {
    const marks = matches.filter(match => match.from < match.to).map(match =>
      Decoration.mark({ class: 'cm-searchMatch' }).range(match.from, match.to));
    this.editor?.dispatch({ effects: this.matches.reconfigure(EditorView.decorations.of(Decoration.set(marks, true))) });
  }

  override layout(): void {
    this.editor?.requestMeasure();
  }
}
