import type { DisposableType } from '@wopjs/disposable';
import type { Writable } from '../common/base';
import type { LsTreeElement } from '../common/git';
import type { TreeNode } from '../common/tree';

import { noop } from '@wopjs/cast';
import { appendChild, detach } from '@wopjs/dom';
import { combine, writable, type Readable } from '@embra/reactivity';
import { $, clearElement } from './dom';
import { Scrollable, type ItemRenderer } from './scrollable';
import { Widget } from './widget';
import { i, ic } from './icon';
import { renderFileIcon } from './file-icon';
import { styleMod } from './css';
import { bindKeys } from './keybindings';

type Item = TreeNode<LsTreeElement>;
type Template = {
  readonly $depth: HTMLSpanElement;
  readonly $arrow: HTMLSpanElement;
  readonly $arrowIcon: HTMLElement;
  readonly $filename: HTMLSpanElement;
  readonly $fileIcon: HTMLElement;
};

export class Files extends Widget implements ItemRenderer<Item, Template> {
  readonly $header: HTMLElement;
  readonly $container: HTMLElement;

  readonly scrollable: Scrollable<Item>;
  readonly selected$: Readable<number | undefined>;

  override initialize(this: Writable<this>): void {
    this.$header = appendChild(this.parent, $('.files-header'));
    const repo = this.root.git.repo;
    const name = (repo.split(/[\\/]/g).pop() || repo).toUpperCase();
    this._register(this.root.git.error$.subscribe(error => {
      this.$header.textContent = error ? 'Could not read files.' : name;
      this.$header.title = error || '';
    }));

    this.$container = appendChild(this.parent, $('.files'));

    const items$ = this.root.git.fileList$;
    this.scrollable = this._register(new Scrollable({
      container: this.$container,
      itemHeight: 22,
      items$,
      renderer: this,
    }));
    const selectedPath$ = this._register(writable<string | undefined>(undefined));
    this.selected$ = this._register(combine([items$, selectedPath$], (items, path) => {
      const index = items.findIndex(item => item.data.file === path);
      return index >= 0 ? index : undefined;
    }));
    this.$container.setAttribute('role', 'tree');
    this.$container.ariaLabel = 'Files';
    this._register(this.scrollable.onDidChangeFocus(index => {
      const item = items$.value[index];
      if (item) {
        selectedPath$.set(item.data.file);
        if (item.data.type === 'blob') {
          window.dispatchEvent(new CustomEvent('editor.open', { detail: item.data.file }));
        }
      }
    }));

    this._register(this.scrollable.onClick(index => {
      const item = items$.value[index];
      if (item?.collapsible) this.root.git.toggle(item.data.file);
    }));

    const style = this._register(styleMod.derive('selected-file'));
    this._register(this.selected$.subscribe(selected => {
      this.scrollable.setFocus(selected);
      let key: string | undefined;
      if (selected != null) {
        const item = items$.value.at(selected);
        key = item?.data.file;
      }
      style.set({
        [`:where(.file:has([data-key="${key}"]))`]: {
          background: 'var(--selected)',
          color: 'var(--accent)',
        }
      });
    }));

    this._register(bindKeys(this.$container, {
      'Enter': () => {
        const current = this.selected$.value;
        if (current != null && items$.value[current].data.type === 'blob') this.root.editor.focus();
      },
      'ArrowLeft,ArrowRight': {
        repeat: true,
        run: e => this.onArrowKey(e),
      },
    }));
  }

  onArrowKey(e: KeyboardEvent): void {
    const current = this.selected$.value;
    if (current == null) return;
    const items = this.root.git.fileList$.value;
    const item = items[current];
    if (e.key === 'ArrowRight') {
      if (item.collapsible) {
        if (item.collapsed) this.root.git.toggle(item.data.file);
        else this.scrollable.focus(current + 1);
      }
    } else if (item.collapsible && !item.collapsed) {
      this.root.git.toggle(item.data.file);
    } else {
      for (let index = current - 1; index >= 0; index--) {
        if (items[index].depth < item.depth) {
          this.scrollable.focus(index);
          break;
        }
      }
    }
  }

  focus(): void {
    this.scrollable.focus(this.selected$.value ?? 0);
  }

  override layout(): void {
  }

  renderTemplate(dom: HTMLDivElement): HTMLDivElement & Template {
    dom.className = 'file';
    dom.setAttribute('role', 'treeitem');
    const $depth = appendChild(dom, $('span.depth'));
    const $arrow = appendChild(dom, $('span.arrow'));
    const $arrowIcon = i('chevron-right');
    const $filename = appendChild(dom, $('span.filename'));
    const $fileIcon = i('file');
    return Object.assign(dom, { $depth, $arrow, $arrowIcon, $filename, $fileIcon });
  }

  renderItem({ $depth, $arrow, $arrowIcon, $filename, $fileIcon }: Template, item: Item): DisposableType<void> {
    $depth.style.paddingLeft = item.depth ? `${item.depth * 10}px` : '';

    if (item.collapsible) {
      $arrowIcon.className = ic(item.collapsed ? 'chevron-right' : 'chevron-down');
      appendChild($arrow, $arrowIcon);
    } else {
      detach($arrowIcon);
    }

    renderFileIcon($fileIcon, item.data.file, item.collapsible, item.collapsed);
    clearElement($filename);
    $filename.append($fileIcon, item.data.file.split('/').pop()!);
    $filename.title = item.data.file + (item.collapsible ? '/' : '');
    $filename.dataset.key = item.data.file;

    return noop;
  }

}
