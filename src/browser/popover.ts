import { listen } from '@wopjs/dom';
import { Disposable } from '../common/disposable';
import { bindKeys } from './keybindings';

export interface PopoverOptions {
  readonly $button: HTMLButtonElement;
  readonly $menu: HTMLElement;
  /** Element to focus when the menu opens, defaults to the menu itself. */
  readonly focus?: () => HTMLElement | undefined;
  /** Global shortcut that toggles the menu; it also closes it from inside. */
  readonly shortcut?: string;
}

/**
 * A button-triggered popover menu.
 *
 * Opening moves focus into the menu, closing always returns it to the button,
 * so pressing the same shortcut again immediately afterwards toggles the menu
 * instead of leaving focus behind.
 */
export class Popover extends Disposable {

  readonly $button: HTMLButtonElement;
  readonly $menu: HTMLElement;
  readonly shortcut: string | undefined;

  /** Pending open, waiting for the content to become ready. */
  opening = false;

  private readonly focus: (() => HTMLElement | undefined) | undefined;

  constructor(options: PopoverOptions) {
    super();
    this.$button = options.$button;
    this.$menu = options.$menu;
    this.focus = options.focus;
    this.shortcut = options.shortcut;
    this._register(listen(this.$button, 'click', e => {
      e.preventDefault();
      this.toggle();
    }));
    if (this.shortcut) {
      this.$button.setAttribute('aria-keyshortcuts', this.shortcut);
      // Capture before MenuNavigation consumes the key as typeahead.
      this._register(bindKeys(this.$menu, {
        [this.shortcut]: () => this.close(true),
      }, true));
    }
  }

  get open(): boolean {
    return this.$menu.matches(':popover-open');
  }

  toggle(): void {
    if (this.open || this.opening) this.close(true);
    else this.show();
  }

  show(): void {
    this.opening = true;
    this.$button.focus();
  }

  reveal(): void {
    this.opening = false;
    this.$menu.showPopover();
    (this.focus?.() || this.$menu).focus();
  }

  close(focus = false): void {
    const wasOpening = this.opening;
    this.opening = false;
    if (this.open) this.$menu.hidePopover();
    if (focus || wasOpening) this.$button.focus();
  }

  override dispose(): void {
    this.close();
    super.dispose();
  }
}
