import type { DisposableType, IDisposable } from '@wopjs/disposable';
import type { ReadonlyVal } from 'value-enhancer';

import { compute, derive, val } from 'value-enhancer';
import { disposableMap, disposableStore } from '@wopjs/disposable';
import { appendChild, detach, element, listen } from '@wopjs/dom';
import { event, send, type IEvent } from '@wopjs/event';

import { scheduleInNextFrame } from './raf';
import { Pool } from './pool';

export interface ScrollableOptions<Item, Template = HTMLDivElement> {
  readonly container: HTMLElement;
  readonly itemHeight: number;
  readonly items$: ReadonlyVal<readonly Item[]>;
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

export class Scrollable<Item, Template = HTMLDivElement> implements IDisposable {

  readonly onClick: IEvent<number>;
  readonly onHover: IEvent<number>;
  readonly visibleRange$: ReadonlyVal<Range>;

  /** Equals to `options.container`, used to track the visual size and scroll position. */
  readonly dom: HTMLElement;
  /** The direct child of `this.dom`, scrolls with its parent and holds absolutely positioned items. */
  readonly content: HTMLDivElement;

  private readonly _store = disposableStore();
  private readonly _itemEffects = this._store.add(disposableMap<Item>());

  constructor(options: ScrollableOptions<Item, Template>) {

    const containerHeight$ = this._store.add(val(0));
    this._store.make(() => {
      const observer = new ResizeObserver((entries) => containerHeight$.set(entries[0].contentRect.height));
      observer.observe(options.container);
      return () => observer.disconnect();
    });

    const contentHeight$ = this._store.add(derive(options.items$, items => items.length * options.itemHeight));

    const scrollTop$ = this._store.add(val(0));
    this._store.add(listen(options.container, 'scroll', () => scrollTop$.set(options.container.scrollTop)));

    const onClick = this.onClick = event<number>();
    const onHover = this.onHover = event<number>();

    this.dom = options.container;
    this.dom.style.cssText = 'overflow:hidden auto;contain:strict';
    const getItemIndex = (e: MouseEvent): number | undefined => {
      const dy = e.clientY - this.dom.getBoundingClientRect().top;
      const itemHeight = options.itemHeight;
      const scrollTop = scrollTop$.value;
      const itemsCount = options.items$.value.length;
      const itemIndex = Math.floor((scrollTop + dy) / itemHeight);
      if (0 <= itemIndex && itemIndex < itemsCount) {
        return itemIndex;
      }
    };
    this._store.add(listen(this.dom, 'mousemove', e => {
      const itemIndex = getItemIndex(e);
      if (itemIndex != null) send(onHover, itemIndex);
    }));
    this._store.add(listen(this.dom, 'click', e => {
      const itemIndex = getItemIndex(e);
      if (itemIndex != null) send(onClick, itemIndex);
    }));

    this.content = appendChild(this.dom, element('div'));
    this._store.add(contentHeight$.subscribe(() => scheduleInNextFrame(() => {
      this.content.style.height = `${contentHeight$.value}px`;
    })));

    const pool = this._store.add(new Pool<Template & HTMLElement>(() => {
      const template = options.renderer.renderTemplate(element('div'));
      template.style.position = 'absolute';
      template.style.width = '100%';
      template.style.height = template.style.lineHeight = `${options.itemHeight}px`;
      template.tabIndex = -1;
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

    this._store.add(visibleRange$.subscribe(range => {
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
          children[i] = null;
          pool.release(e.dom);
        }
        const dom = pool.alloc();
        dom.style.top = `${options.itemHeight * i}px`;
        children[i] = { data: item, dom };
        this._itemEffects.flush(item);
        this._itemEffects.set(item, options.renderer.renderItem(dom, item));
        appendChild(this.content, dom);
      }

      added.clear();
      removed.clear();
    }));

    this._store.add(options.items$.reaction((items) => {
      const { start, end } = visibleRange$.value;
      for (let i = start; i < end; i++) {
        const item = items[i];
        const e = children[i];
        if (e) {
          this._itemEffects.flush(item);
          this._itemEffects.set(item, options.renderer.renderItem(e.dom, item));
        }
      }
    }));
  }

  dispose() {
    this._store.dispose();
    detach(this.content);
    this.content.textContent = '';
  }
}
