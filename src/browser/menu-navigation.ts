import { listen } from '@wopjs/dom';
import { Disposable } from '../common/disposable';
import { bindKeys, onKeyDown } from './keybindings';

export class MenuNavigation extends Disposable {

  private prefix = '';
  private lastInput = 0;

  constructor(
    dom: HTMLElement,
    private readonly items: readonly HTMLElement[],
    private readonly getLabel: (item: HTMLElement) => string,
    private readonly onFocus: (item: HTMLElement) => void,
  ) {
    super();
    this._register(bindKeys(dom, {
      'ArrowUp,ArrowDown': { repeat: true, run: e => this.onArrowKey(e) },
    }));
    this._register(onKeyDown(dom, e => this.onType(e)));
    this._register(listen(dom, 'focusout', e => {
      if (!(e.relatedTarget instanceof Node) || !dom.contains(e.relatedTarget)) this.prefix = '';
    }));
    this._register(listen(dom, 'pointerdown', () => this.prefix = ''));
  }

  private onArrowKey(e: KeyboardEvent): void {
    this.prefix = '';
    const current = this.items.indexOf(document.activeElement as HTMLElement);
    this.focus(current < 0 ? 0 : current + (e.key === 'ArrowUp' ? -1 : 1));
  }

  private onType(e: KeyboardEvent): boolean {
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key.length !== 1 || e.key === ' ') {
      this.prefix = '';
      return false;
    }
    const now = Date.now();
    if (now - this.lastInput > 1000) this.prefix = '';
    this.lastInput = now;
    this.prefix += e.key.toLowerCase();
    this.focus(this.items.findIndex(item => this.getLabel(item).toLowerCase().startsWith(this.prefix)));
    return true;
  }

  private focus(index: number): void {
    const item = this.items[index];
    if (item) {
      item.focus();
      this.onFocus(item);
    }
  }
}
