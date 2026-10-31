import type { IMain } from './widget';

import { appendChild, listen } from '@wopjs/dom';
import { Disposable } from '../common/disposable';
import { SnapshotKind } from '../common/git';
import { renderDate } from './commit-content';
import { Commits } from './commits';
import { styleMod } from './css';
import { $ } from './dom';
import { Editor } from './editor';
import { Files } from './files';
import { Git } from './git';
import { i } from './icon';
import { Status } from './status';
import { Search } from './search';
import { SnapshotIndex } from './symbol-index';
import { bindKeys } from './keybindings';

// Remove browser.js from HTML.
document.querySelector('script')?.remove();

class Main extends Disposable implements IMain {
  static async initialize() {
    const git = await Git.init();
    globalThis.dev = new Main(git);
  }

  readonly dom: {
    readonly $titlebar: HTMLElement,
    readonly $title: HTMLElement,
    readonly $content: HTMLElement,
    readonly $sidebar: HTMLElement,
    readonly $editors: HTMLElement,
    readonly $auxSidebar: HTMLElement,
    readonly $statusbar: HTMLElement,
  };

  readonly files: Files;
  readonly editor: Editor;
  readonly commits: Commits;
  readonly status: Status;
  readonly symbolIndex: SnapshotIndex;

  constructor(readonly git: Git) {
    super();
    this.symbolIndex = this._register(new SnapshotIndex(git));
    const $titlebar = appendChild(document.body, $('header.titlebar'));
    const $navigation = appendChild($titlebar, $('.titlebar-navigation'));
    const $back = appendChild($navigation, $('button'));
    const $forward = appendChild($navigation, $('button'));
    $back.type = $forward.type = 'button';
    appendChild($back, i('arrow-left'));
    appendChild($forward, i('arrow-right'));
    $back.title = 'Go back (Ctrl+-)';
    $forward.title = 'Go forward (Ctrl+Shift+-)';
    $back.ariaLabel = 'Go back';
    $forward.ariaLabel = 'Go forward';
    const $title = appendChild($titlebar, $('.titlebar-title'));
    const $date = appendChild($titlebar, $('.titlebar-date'));
    this._register(git.snapshot$.subscribe(snapshot => {
      const date = snapshot?.kind === SnapshotKind.WorkingTree ? snapshot.date : snapshot?.authorDate;
      $date.textContent = renderDate(date);
      $date.title = date?.toString() || '';
    }));
    const $content = appendChild(document.body, $('main.content'));
    const $sidebar = appendChild($content, $('aside.sidebar'));
    const $editors = appendChild($content, $('div.editors'));
    const $auxSidebar = appendChild($content, $('aside.aux-sidebar'));
    const $statusbar = appendChild(document.body, $('footer.statusbar'));
    this.dom = { $titlebar, $title, $content, $sidebar, $auxSidebar, $editors, $statusbar };

    // Setup widgets.
    this.files = new Files($sidebar, this);
    this.editor = new Editor($editors, this);
    this.commits = new Commits($auxSidebar, this);
    this.status = new Status($statusbar, this);
    this._register(new Search(document.body, this));
    $back.onclick = () => this.editor.go(-1);
    $forward.onclick = () => this.editor.go(1);
    this._register(this.editor.navigation$.subscribe(({ back, forward }) => {
      $back.disabled = !back;
      $forward.disabled = !forward;
    }));

    const canNavigate = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (target.closest('input, textarea, select, dialog[open], [role="menu"], [popover]:popover-open')) return false;
        const view = this.editor.editor;
        if (target.isContentEditable && !(view?.state.readOnly && view.contentDOM.contains(target))) return false;
      }
      return true;
    };
    this._register(bindKeys(window, {
      'b': { when: canNavigate, run: () => this.status.openBranches() },
      'd': { when: canNavigate, run: () => this.status.openChanges() },
      'e': { when: canNavigate, run: () => { this.status.closeMenus(); this.files.focus(); } },
      'c': { when: canNavigate, run: () => { this.status.closeMenus(); this.commits.focus(); } },
      'v': { when: canNavigate, run: () => { this.status.closeMenus(); this.editor.focus(); } },
      'z': { when: canNavigate, run: () => this.editor.image?.toggleMenu() },
    }));
    this._register(bindKeys(window, {
      'Ctrl+-': { when: canNavigate, run: () => this.editor.go(-1) },
      'Ctrl+Shift+-,Ctrl+Shift+_': { when: canNavigate, run: () => this.editor.go(1) },
    }, true));

    // Render.
    const viewport = window.visualViewport || window;
    this._register(listen(viewport as Window, 'resize', () => this.layout()));
    this.layout();

    this.setTitle();
  }

  layout() {
    styleMod.set(':root', {
      '--track-0': 'light-dark(#1A85ff,#3794FF)', // blue
      '--track-1': 'light-dark(#652D90,#B180D7)', // purple
      '--track-2': 'light-dark(#E51400,#F14C4C)', // red
      '--track-3': '#D18616',                     // orange
      '--track-4': 'light-dark(#BF8803,#CCA700)', // yellow
      '--track-5': 'light-dark(#388A34,#89D185)', // green
    });

    const { clientWidth, clientHeight } = document.body;
    styleMod.set('.titlebar', {
      height: '28px',
      lineHeight: '28px',
      textAlign: 'center',
      borderBottom: '1px solid var(--border)',
    });
    styleMod.set('.content', {
      top: '28px',
      height: `${clientHeight - 50}px`,
      overflow: 'hidden',
    });
    styleMod.set('.statusbar', {
      top: `${clientHeight - 22}px`,
      height: '22px',
      borderTop: '1px solid var(--border)',
    });
    styleMod.set('.sidebar', {
      width: '250px',
      borderRight: '1px solid var(--border)',
      overflow: 'hidden',
    });
    styleMod.set('.editors', {
      left: '250px',
      width: `${clientWidth - 500}px`,
    });
    styleMod.set('.aux-sidebar', {
      left: `${clientWidth - 250}px`,
      width: '250px',
      borderLeft: '1px solid var(--border)',
    });
    this.files.layout();
    this.editor.layout();
    this.commits.layout();
  }

  setTitle(filename?: string): void {
    const repo = this.git.repo.split(/[\\/]/g).pop() || this.git.repo;
    const title = filename ? `${filename} — ${repo}` : repo;
    this.dom.$title.textContent = title;
    document.title = title;
  }
}

Main.initialize().catch(console.error);
