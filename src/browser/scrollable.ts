import type { DisposableType } from '@wopjs/disposable';
import type { Readable } from '@embra/reactivity';

import { compute, derive, writable } from '@embra/reactivity';
import { disposableMap } from '@wopjs/disposable';
import { appendChild, detach, element, listen } from '@wopjs/dom';
import { event, send, type IEvent } from '@wopjs/event';
import { Disposable } from '../common/disposable';
import { clamp } from '../common/base';
import { scheduleInNextFrame } from './raf';
import { Pool } from './pool';
import { Scrollbars } from './scrollbars';
import { bindKeys } from './keybindings';

export interface ScrollableOptions<Item, Template = HTMLDivElement> {
  readonly container: HTMLElement;
  readonly itemHeight: number;
  readonly items$: Readable<readonly Item[]>;
  readonly renderer: ItemRenderer<Item, Template>;
}

export interface ItemRenderer<Item, Template = HTMLDivElement> {
  renderTemplate(dom: HTMLDivElement): HTMLDivElement & Template;
  renderItem(template: Template, item: Item): DisposableType<void>;
}

export interface Range {
  readonly start: number;
  readonly end: number;
};

export class Scrollable<Item, Template = HTMLDivElement> extends Disposable {

  readonly itemHeight: number;

  readonly onDidChangeFocus = event<number>();
  readonly onClick: IEvent<number>;
  readonly onDblClick: IEvent<number>;
  readonly visibleRange$: Readable<Range>;

  /** Equals to `options.container`, used to track the visual size and scroll position. */
  readonly $dom: HTMLElement;
  /** The direct child of `this.$dom`, scrolls with its parent and holds absolutely positioned items. */
  readonly $content: HTMLDivElement;

  private static nextId = 0;
  private readonly id = `list-${Scrollable.nextId++}`;
  private readonly items$: Readable<readonly Item[]>;
  private focused: number | undefined;

  private readonly _itemEffects = this._register(disposableMap<Item>());

  constructor(options: ScrollableOptions<Item, Template>) {
    super();
    this.itemHeight = options.itemHeight;
    this.items$ = options.items$;
    const containerHeight$ = this._register(writable(0));
    const observer = new ResizeObserver((entries) => containerHeight$.set(entries[0].contentRect.height));
    observer.observe(options.container);
    this._register(() => observer.disconnect());

    const contentHeight$ = this._register(derive(options.items$, items => items.length * options.itemHeight));

    const scrollTop$ = this._register(writable(0));
    this._register(listen(options.container, 'scroll', () => scrollTop$.set(options.container.scrollTop)));

    const onClick = this.onClick = event<number>();
    const onDblClick = this.onDblClick = event<number>();

    this.$dom = options.container;
    this.$dom.tabIndex = 0;
    this.$dom.setAttribute('role', 'listbox');
    this._register(bindKeys(this.$dom, {
      'ArrowUp,ArrowDown': { repeat: true, run: e => this.onArrowKey(e) },
      'PageUp,PageDown': { repeat: true, run: e => this.onPageKey(e) },
      'Escape': () => this.$dom.blur(),
    }));
    this.$dom.style.cssText = 'overflow:hidden auto;contain:strict';
    const getItemIndex = (e: MouseEvent): number | undefined => {
      const dy = e.clientY - this.$dom.getBoundingClientRect().top;
      const itemHeight = options.itemHeight;
      const scrollTop = scrollTop$.value;
      const itemsCount = options.items$.value.length;
      const itemIndex = Math.floor((scrollTop + dy) / itemHeight);
      if (0 <= itemIndex && itemIndex < itemsCount) {
        return itemIndex;
      }
    };
    this._register(listen(this.$dom, 'click', e => {
      const itemIndex = getItemIndex(e);
      if (itemIndex != null) {
        this.focus(itemIndex);
        send(onClick, itemIndex);
      }
    }));
    this._register(listen(this.$dom, 'dblclick', e => {
      const itemIndex = getItemIndex(e);
      if (itemIndex != null) send(onDblClick, itemIndex);
    }));

    this.$content = appendChild(this.$dom, element('div'));
    this._register(new Scrollbars(this.$dom, this.$content));
    this._register(contentHeight$.subscribe(() => scheduleInNextFrame(() => {
      this.$content.style.height = `${contentHeight$.value}px`;
    })));

    const pool = this._register(new Pool<Template & HTMLElement>(() => {
      const template = options.renderer.renderTemplate(element('div'));
      template.style.position = 'absolute';
      template.style.width = '100%';
      template.style.height = template.style.lineHeight = `${options.itemHeight}px`;
      if (!template.hasAttribute('role')) template.setAttribute('role', 'option');
      return template;
    }));

    const visibleRange$ = this.visibleRange$ = compute<Range>(get => {
      const containerHeight = get(containerHeight$);
      const scrollTop = get(scrollTop$);
      const itemsCount = get(options.items$).length;
      const itemHeight = options.itemHeight;
      return {
        start: Math.max(0, Math.floor(scrollTop / itemHeight)),
        end: Math.min(itemsCount, Math.ceil((scrollTop + containerHeight) / itemHeight))
      };
    }, { equal: (a, b) => a.start === b.start && a.end === b.end });

    let lastRange: Range = { start: 0, end: 0 };
    const added = new Set<number>(), removed = new Set<number>();
    const children: ({ data: Item, dom: HTMLElement & Template; } | null)[] = [];

    this._register(visibleRange$.subscribe(range => {
      const { start, end } = range;
      const { start: lastStart, end: lastEnd } = lastRange;
      for (let i = start; i < end; i++) {
        if (i < lastStart || i >= lastEnd) {
          added.add(i);
        }
      }
      for (let i = lastStart; i < lastEnd; i++) {
        if (i < start || i >= end) {
          removed.add(i);
        } else {
          added.add(i);
        }
      }

      lastRange = range;

      for (const i of removed) {
        const e = children[i];
        if (e) {
          this._itemEffects.flush(e.data);
          children[i] = null;
          pool.release(e.dom);
          detach(e.dom);
        }
      }

      const items = options.items$.value;
      for (const i of added) {
        const item = items[i];
        const e = children[i];
        if (e?.data === item) {
          continue;
        }
        if (e) {
          this._itemEffects.flush(e.data);
          children[i] = null;
          pool.release(e.dom);
        }
        const dom = pool.alloc();
        dom.dataset.index = i.toString();
        dom.id = `${this.id}-${i}`;
        dom.style.top = `${options.itemHeight * i}px`;
        children[i] = { data: item, dom };
        this._itemEffects.flush(item);
        this._itemEffects.set(item, options.renderer.renderItem(dom, item));
        appendChild(this.$content, dom);
      }

      this.renderFocus();
      added.clear();
      removed.clear();
    }));

    this._register(options.items$.reaction((items) => {
      const { start, end } = visibleRange$.value;
      for (let i = start; i < end; i++) {
        const item = items[i];
        const e = children[i];
        if (e) {
          this._itemEffects.flush(e.data);
          e.data = item;
          this._itemEffects.set(item, options.renderer.renderItem(e.dom, item));
        }
      }
    }));
  }

  private onArrowKey(e: KeyboardEvent): void {
    this.focus(this.focused == null ? 0 : this.focused + (e.key === 'ArrowUp' ? -1 : 1));
  }

  private onPageKey(e: KeyboardEvent): void {
    if (this.focused == null) {
      this.focus(0);
    } else {
      const step = e.key === 'PageUp' ? -10 : 10;
      this.focus(this.focused + step);
    }
  }

  setFocus(index: number | undefined): void {
    const next = this.items$.value.length && index != null ? clamp(index, 0, this.items$.value.length - 1) : undefined;
    this.focused = next;
    this.renderFocus();
  }

  focus(index: number): void {
    this.$dom.focus({ preventScroll: true });
    const previous = this.focused;
    this.setFocus(index);
    if (this.focused != null) {
      this.reveal(this.focused);
      if (previous !== this.focused) send(this.onDidChangeFocus, this.focused);
    }
  }

  reveal(index: number): void {
    const top = index * this.itemHeight;
    const bottom = top + this.itemHeight;
    if (top < this.$dom.scrollTop) this.$dom.scrollTop = top;
    else if (bottom > this.$dom.scrollTop + this.$dom.clientHeight) {
      this.$dom.scrollTop = bottom - this.$dom.clientHeight;
    }
  }

  private renderFocus(): void {
    let active: string | undefined;
    for (const child of this.$content.children) {
      const row = child as HTMLElement;
      const focused = Number(row.dataset.index) === this.focused;
      row.classList.toggle('focused', focused);
      row.setAttribute('aria-selected', String(focused));
      if (focused) active = row.id;
    }
    if (active) this.$dom.setAttribute('aria-activedescendant', active);
    else this.$dom.removeAttribute('aria-activedescendant');
  }

  scrollTo(index: number): void {
    this.$dom.scrollTo({ top: index * this.itemHeight });
  }

  override dispose() {
    super.dispose();
    detach(this.$content);
    this.$content.textContent = '';
  }
}
