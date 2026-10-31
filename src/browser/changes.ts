import type { Writable } from '../common/base';
import type { CommitShortStat, Diff, Snapshot } from '../common/git';
import type { DiffTarget } from './editor';

import { appendChild, listen } from '@wopjs/dom';
import { noop } from '@wopjs/cast';
import { EditorTargetKind } from './editor';
import { SnapshotKind } from '../common/git';
import { $, clearElement } from './dom';
import { Widget } from './widget';
import { i } from './icon';
import { MenuNavigation } from './menu-navigation';
import { Popover } from './popover';
import { Scrollbars } from './scrollbars';
import { bindKeys } from './keybindings';

export class Changes extends Widget {

  readonly $button: HTMLButtonElement;
  readonly $menu: HTMLElement;
  readonly $content: HTMLElement;
  readonly $label: HTMLElement;
  readonly $del: HTMLElement;
  readonly $ins: HTMLElement;

  readonly popover: Popover;
  readonly items: HTMLButtonElement[] = [];

  request = 0;
  diff: Diff | undefined;
  snapshot: Snapshot | undefined;
  ready = false;

  override initialize(this: Writable<this>): void {
    const $button = this.$button = appendChild(this.parent, $('button.changes-button'));
    $button.type = 'button';
    $button.setAttribute('popovertarget', 'changes-menu');
    $button.setAttribute('aria-haspopup', 'menu');
    $button.ariaLabel = 'Changed files';
    appendChild($button, i('diff'));
    this.$label = appendChild($button, $('span'));
    this.$del = appendChild($button, $('span.del'));
    this.$ins = appendChild($button, $('span.ins'));

    const $menu = this.$menu = appendChild(this.parent, $('.changes-menu'));
    $menu.id = 'changes-menu';
    $menu.popover = '';
    $menu.tabIndex = -1;
    $menu.setAttribute('role', 'menu');
    $menu.ariaLabel = 'Changed files';
    this.$content = appendChild($menu, $('.menu-content'));
    this._register(new Scrollbars(this.$content));

    this.popover = this._register(new Popover({
      $button,
      $menu,
      shortcut: 'd',
      focus: () => this.items[0],
    }));
    this._register(listen(window, 'pointerdown', e => {
      if (this.popover.opening && !this.parent.contains(e.target as Node)) this.close();
    }));
    this._register(listen($button, 'blur', () => {
      this.popover.opening = false;
    }));

    const open = ($item: HTMLElement, focus: boolean) => {
      const file = this.diff?.files[Number($item.dataset.index)];
      if (file && this.diff && this.snapshot && this.snapshot === this.root.git.snapshot$.value) {
        const detail: DiffTarget = { kind: EditorTargetKind.Diff, snapshot: this.snapshot, range: this.diff.range, file };
        window.dispatchEvent(new CustomEvent('editor.diff', { detail }));
        this.close();
        if (focus) this.root.editor.focus();
        else $button.focus();
      }
    };
    this._register(listen($menu, 'click', e => {
      const $item = (e.target as HTMLElement).closest<HTMLElement>('.change-file');
      if ($item) open($item, false);
    }));

    this._register(new MenuNavigation(
      $menu,
      this.items,
      item => {
        const file = this.diff?.files[Number(item.dataset.index)].newPath || '';
        return file.slice(file.lastIndexOf('/') + 1);
      },
      noop,
    ));
    this._register(bindKeys($menu, {
      'Enter,Space'(e) {
        const $item = (e.target as HTMLElement).closest<HTMLElement>('.change-file');
        if ($item) open($item, true);
      },
    }, true));

    this._register(this.root.git.snapshot$.subscribe(snapshot => {
      this.close();
      this.request++;
      this.ready = false;
      this.diff = undefined;
      this.items.length = 0;
      this.snapshot = snapshot;
      $button.disabled = !snapshot;
      if (!snapshot?.parents.length) {
        $button.title = 'Changes against empty tree';
      } else if (snapshot.kind === SnapshotKind.WorkingTree) {
        $button.title = 'Changes against HEAD (tracked files only)';
      } else {
        $button.title = 'Changes against first parent';
      }
      $button.title += ' (d)';
      this.renderStat();
      if (snapshot) void this.load();
    }));
    this._register(() => this.request++);
  }

  renderStat(stat?: CommitShortStat): void {
    this.$label.textContent = stat ? `${stat.files} files` : '';
    this.$del.textContent = stat?.deletions ? `-${stat.deletions}` : '';
    this.$ins.textContent = stat?.insertions ? `+${stat.insertions}` : '';
  }

  async load(): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;

    const request = ++this.request;
    this.diff = undefined;
    try {
      const diff = await this.root.git.diff(snapshot);
      if (request !== this.request || snapshot !== this.snapshot) return;
      this.diff = diff;
      this.renderStat({
        files: diff.files.length,
        insertions: diff.files.reduce((sum, file) => sum + (file.insertions ?? 0), 0),
        deletions: diff.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      });

      clearElement(this.$content);
      this.items.length = 0;
      if (!diff.files.length) appendChild(this.$content, $('.changes-note')).textContent = 'No changes.';
      diff.files.forEach((file, index) => {
        const $item = appendChild(this.$content, $('button.change-file'));
        $item.type = 'button';
        $item.tabIndex = -1;
        $item.setAttribute('role', 'menuitem');
        $item.dataset.index = String(index);
        this.items.push($item);

        const $status = appendChild($item, $('code.change-status'));
        $status.textContent = $status.dataset.status = file.status[0];

        const $path = appendChild($item, $('span.change-path'));
        $path.textContent = file.oldPath === file.newPath ? file.newPath : `${file.oldPath} → ${file.newPath}`;
        $item.title = $path.textContent;

        if (file.insertions == null) {
          appendChild($item, $('span')).textContent = 'Binary';
        } else {
          appendChild($item, $('span.del')).textContent = `-${file.deletions}`;
          appendChild($item, $('span.ins')).textContent = `+${file.insertions}`;
        }
      });
    } catch (error) {
      if (request === this.request) {
        this.items.length = 0;
        this.$content.textContent = 'Could not read changes.';
      }
    }

    if (request === this.request) {
      this.ready = true;
      if (this.popover.opening) this.open();
    }
  }

  open(): void {
    if (!this.snapshot) return;
    if (!this.ready) {
      this.popover.show();
      return;
    }

    this.popover.reveal();
  }

  close(): void {
    this.popover.close();
  }

  override layout(): void {
  }
}
