import { disposableStore, type IDisposable } from '@wopjs/disposable';
import { appendChild, listen } from '@wopjs/dom';
import { Commits } from './commits';
import { styleMod } from './css';
import { $ } from './dom';
import { Editor } from './editor';
import { Files } from './files';
import { Git } from './git';
import { Status } from './status';
import { Widget, type IMain } from './widget';

// Remove browser.js from HTML.
document.querySelector('script')?.remove();

class Main implements IMain, IDisposable {
  static async initialize() {
    const git = await Git.init();
    globalThis.dev = new Main(git);
  }

  private readonly _store = disposableStore();

  readonly dom: {
    readonly $titlebar: HTMLElement,
    readonly $content: HTMLElement,
    readonly $sidebar: HTMLElement,
    readonly $editors: HTMLElement,
    readonly $auxSidebar: HTMLElement,
    readonly $statusbar: HTMLElement,
  };

  readonly files: Widget;
  readonly editor: Widget;
  readonly commits: Widget;
  readonly status: Widget;

  constructor(readonly git: Git) {
    const $titlebar = appendChild(document.body, $('header.titlebar'));
    const $content = appendChild(document.body, $('main.content'));
    const $sidebar = appendChild($content, $('aside.sidebar'));
    const $editors = appendChild($content, $('div.editors'));
    const $auxSidebar = appendChild($content, $('aside.aux-sidebar'));
    const $statusbar = appendChild(document.body, $('footer.statusbar'));
    this.dom = { $titlebar, $content, $sidebar, $auxSidebar, $editors, $statusbar };

    // Setup widgets.
    this.files = new Files($sidebar, this);
    this.editor = new Editor($editors, this);
    this.commits = new Commits($auxSidebar, this);
    this.status = new Status($statusbar, this);

    // Render.
    const viewport = window.visualViewport || window;
    this._store.add(listen(viewport as Window, 'resize', () => this.layout()));
    this.layout();

    this.setTitle(git.repo.split(/[\\/]/g).pop() || git.repo);
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

  setTitle(title: string): void {
    this.dom.$titlebar.textContent = title;
    document.title = title;
  }

  dispose() {
    this._store.dispose();
  }
}

Main.initialize().catch(console.error);
