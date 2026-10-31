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
  /**
   * Whether the content is ready to be shown. Async menus start loading when
   * `onLoad` is called and open once `ready()` turns true, via `notify()`.
   */
  readonly ready?: () => boolean;
  /** Owner-provided load routine, called whenever an open is requested. */
  readonly onLoad?: () => void;
  readonly dismissWithin?: HTMLElement;
}

export class Popover extends Disposable {

  readonly $button: HTMLButtonElement;
  readonly $menu: HTMLElement;
  readonly shortcut: string | undefined;

  private pending = false;

  private readonly focus: (() => HTMLElement | undefined) | undefined;
  private readonly ready: (() => boolean) | undefined;
  private readonly onLoad: (() => void) | undefined;

  constructor(options: PopoverOptions) {
    super();
    this.$button = options.$button;
    this.$menu = options.$menu;
    this.focus = options.focus;
    this.shortcut = options.shortcut;
    this.ready = options.ready;
    this.onLoad = options.onLoad;
    // Auto-mode popovers light-dismiss on the button's own pointerdown, so the
    // following click would reopen the menu instead of toggling it closed.
    this.$menu.popover = 'manual';
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
    if (options.dismissWithin) {
      const within = options.dismissWithin;
      this._register(listen(window, 'pointerdown', e => {
        const target = e.target as Node;
        if (this.open && !within.contains(target) && !this.$button.contains(target)) this.close();
      }));
    }
  }

  get open(): boolean {
    return this.pending || this.$menu.matches(':popover-open');
  }

  toggle(): void {
    if (this.open) {
      this.close(true);
    } else if (this.ready && !this.ready()) {
      this.pending = true;
      this.$button.focus();
      this.onLoad?.();
    } else {
      this.reveal();
    }
  }

  notify(): void {
    if (this.pending) this.reveal();
  }

  cancel(): void {
    this.pending = false;
  }

  reveal(): void {
    this.pending = false;
    if (!this.$menu.matches(':popover-open')) this.$menu.showPopover();
    (this.focus?.() || this.$menu).focus();
  }

  close(focus = false): void {
    const wasOpen = this.open;
    this.pending = false;
    if (this.$menu.matches(':popover-open')) this.$menu.hidePopover();
    if (focus && wasOpen) this.$button.focus();
  }

  override dispose(): void {
    this.close();
    super.dispose();
  }
}
