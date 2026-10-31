import { appendChild } from '@wopjs/dom';
import { $ } from './dom';
import { Widget } from './widget';

export class Help extends Widget {
  override initialize(): void {
    const $button = appendChild(this.parent, $('button.help-button'));
    $button.textContent = '?';
    $button.type = 'button';
    $button.title = 'Keyboard shortcuts (?)';
    $button.ariaLabel = 'Keyboard shortcuts';
    $button.setAttribute('popovertarget', 'keyboard-help');
    $button.setAttribute('aria-haspopup', 'dialog');

    const $help = appendChild(document.body, $('.keyboard-help'));
    $help.id = 'keyboard-help';
    $help.popover = 'auto';
    $help.tabIndex = -1;
    $help.setAttribute('role', 'dialog');
    $help.setAttribute('aria-modal', 'true');
    $help.setAttribute('aria-labelledby', 'keyboard-help-title');
    appendChild($help, $('h2#keyboard-help-title')).textContent = 'Keyboard shortcuts';

    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
    const sections = [
      ['Navigation', [
        ['?', 'Show keyboard shortcuts'],
        ['B', 'Switch branch'],
        ['D', 'Show changed files'],
        ['E', 'Focus files'],
        ['C', 'Focus commits'],
        ['V', 'Focus editor'],
        ['Z', 'Change image zoom'],
      ]],
      ['Search', [
        [`${mod} + F`, 'Find in file'],
        [`${mod} + Shift + F`, 'Find in all files'],
        [`${mod} + P`, 'Find file'],
        [`${mod} + K`, 'Find commit'],
        [`${mod} + Shift + K`, 'Compare file with commit'],
      ]],
      ['Symbols (editor focused)', [
        ['Ctrl + -', 'Go back'],
        ['Ctrl + Shift + -', 'Forward'],
        [`${mod} + R / ${mod} + Alt + O`, 'Find symbol in file'],
        [`${mod} + Shift + R`, 'Find all symbols'],
        ['F12', 'Go to definition'],
        ['Shift + F12', 'Find references'],
        [`${mod} + Alt + F12`, 'Find all symbol locations'],
      ]],
      ['Lists and menus', [
        ['↑ / ↓', 'Move selection'],
        ['← / →', 'Collapse or expand folder'],
        ['Enter', 'Open selection'],
        ['Esc', 'Cancel'],
      ]],
    ] as const;
    for (const [title, shortcuts] of sections) {
      appendChild($help, $('h3')).textContent = title;
      const $list = appendChild($help, $('dl'));
      for (const [key, description] of shortcuts) {
        const $keys = appendChild($list, $('dt'));
        for (const part of key.split(/ (\+|\/) /)) {
          if (part === '+' || part === '/') $keys.append(` ${part} `);
          else appendChild($keys, $('kbd')).textContent = part;
        }
        appendChild($list, $('dd')).textContent = description;
      }
    }
    const $close = appendChild($help, $('button.help-close'));
    $close.type = 'button';
    $close.append('Close ');
    appendChild($close, $('kbd')).textContent = 'Esc';
    $close.onclick = () => $help.hidePopover();

    let previousFocus: HTMLElement | null = null;
    const background: HTMLElement[] = [];
    $help.addEventListener('beforetoggle', e => {
      if (e.newState === 'open') {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        for (const element of document.body.children) {
          if (element instanceof HTMLElement && element !== $help && !element.inert) {
            background.push(element);
            element.inert = true;
          }
        }
      } else {
        for (const element of background) element.inert = false;
        background.length = 0;
        if (previousFocus?.checkVisibility()) previousFocus.focus();
        else $button.focus();
      }
    });
    $help.addEventListener('toggle', () => {
      if ($help.matches(':popover-open')) $help.focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if ($help.matches(':popover-open')) {
        e.stopImmediatePropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          $help.hidePopover();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          $close.focus();
        }
        return;
      }
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.key !== '?') return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (target.closest('input, textarea, select, dialog[open]')) return;
        const view = this.root.editor.editor;
        if (target.isContentEditable && !(view?.state.readOnly && view.contentDOM.contains(target))) return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) $help.showPopover();
    };
    window.addEventListener('keydown', onKeyDown, true);
    this._register(() => {
      $help.hidePopover();
      $help.remove();
      $button.remove();
      window.removeEventListener('keydown', onKeyDown, true);
    });
  }

  override layout(): void {
  }
}
