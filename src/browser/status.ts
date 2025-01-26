import type { Writable } from '../base';

import { subscribe, val, type Val } from 'value-enhancer';
import { appendChild } from '@wopjs/dom';
import { $, clearElement, onCustomEvent } from './dom';
import { Widget } from './widget';
import { i } from './icon';
import { scheduleInNextFrame } from './raf';

export class Status extends Widget {

  readonly branch$: Val<string | null>;

  override initialize(this: Writable<this>): void {
    const $gitBranch = appendChild(this.parent, $('.git-branch'));
    $gitBranch.setAttribute('popovertarget', 'git-branch-menu');
    appendChild($gitBranch, i('source-control'));

    const $name = appendChild($gitBranch, $('span.git-branch-name'));
    const $loading = appendChild($gitBranch, i('loading'));
    $loading.style.display = 'none';

    const $menu = appendChild(this.parent, $('.git-branch-menu'));
    $menu.popover = "";
    $menu.id = 'git-branch-menu';

    for (const ref of this.root.git.refs) {
      if (ref.name && ref.name !== 'origin/HEAD') {
        const $branch = appendChild($menu, $('.menu-item'));
        $branch.textContent = ref.name;
      }
    }
    $menu.onclick = async e => {
      e.stopPropagation();
      const refName = (e.target as HTMLElement)?.textContent;
      if (refName) {
        const loading = setTimeout(() => { $loading.style.display = ''; }, 100);
        this.branch$.set(refName);
        $menu.togglePopover(false);
        await this.root.git.goto(refName);
        clearTimeout(loading);
        $loading.style.display = 'none';
      }
    };
    $gitBranch.onclick = () => $menu.togglePopover();

    const $changes = appendChild(this.parent, $('.changes-detail'));
    this._register(subscribe(this.root.git.commit$, commit => {
      clearElement($changes);
      if (commit?.shortStat) {
        if (commit.shortStat.deletions) {
          appendChild($changes, $('span.del')).textContent = `-${commit.shortStat.deletions}`;
        }
        if (commit.shortStat.insertions) {
          appendChild($changes, $('span.ins')).textContent = `+${commit.shortStat.insertions}`;
        }
      }
    }));

    appendChild(this.parent, $('.space'));
    const $pinned = appendChild(this.parent, $('.pinned'));
    this._register(onCustomEvent('pinned', e => {
      $pinned.textContent = e.detail ? 'Pinned.' : '';
    }));

    this.branch$ = this._register(val<string | null>(this.root.git.refs[0].name || null));

    this._register(this.branch$.subscribe((branch) => {
      $name.textContent = branch;
    }));
  }

  override layout(): void {
  }
}
