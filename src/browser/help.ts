import { appendChild } from '@wopjs/dom';
import { $ } from './dom';
import { Widget } from './widget';
import { Scrollbars } from './scrollbars';
import { Popover } from './popover';
import { bindKeys } from './keybindings';

export class Help extends Widget {
  override initialize(): void {
    const $button = appendChild(this.parent, $('button.help-button'));
    $button.textContent = '?';
    $button.type = 'button';
    $button.title = 'Keyboard shortcuts (?)';
    $button.ariaLabel = 'Keyboard shortcuts';
    $button.setAttribute('aria-haspopup', 'dialog');

    const $help = appendChild(this.parent, $('.keyboard-help'));
    $help.id = 'keyboard-help';
    $help.tabIndex = -1;
    $help.setAttribute('role', 'dialog');
    $help.setAttribute('aria-labelledby', 'keyboard-help-title');
    const $content = appendChild($help, $('.keyboard-help-content'));
    this._register(new Scrollbars($content));
    appendChild($content, $('h2#keyboard-help-title')).textContent = 'Keyboard shortcuts';

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
        [`${mod} + R / ${mod} + Shift + O`, 'Find symbol in file'],
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
      appendChild($content, $('h3')).textContent = title;
      const $list = appendChild($content, $('dl'));
      for (const [key, description] of shortcuts) {
        const $keys = appendChild($list, $('dt'));
        for (const part of key.split(/ (\+|\/) /)) {
          if (part === '+' || part === '/') $keys.append(` ${part} `);
          else appendChild($keys, $('kbd')).textContent = part;
        }
        appendChild($list, $('dd')).textContent = description;
      }
    }
    const $close = appendChild($content, $('button.help-close'));
    $close.type = 'button';
    $close.append('Close ');
    appendChild($close, $('kbd')).textContent = 'Esc';

    const popover = this._register(new Popover({
      $button,
      $menu: $help,
      shortcut: 'Shift+?',
      focus: () => $help,
      dismissWithin: $help,
    }));
    $close.onclick = () => popover.close(true);
    this._register(bindKeys($help, { 'Escape': () => popover.close(true) }, true));
    // The popover's own shortcut only fires from inside the menu, so open it here.
    this._register(bindKeys(window, {
      'Shift+?': {
        when: e => popover.open || canShowHelp(e),
        run: () => popover.toggle(),
      },
    }, true));
  }

  override layout(): void {
  }
}

function canShowHelp(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return true;
  return !target.closest('input, textarea, select, dialog[open]');
}
