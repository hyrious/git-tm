import type { Writable } from '../common/base';

import { writable, type Writable as ReactiveWritable } from '@embra/reactivity';
import { appendChild } from '@wopjs/dom';
import { $, onCustomEvent } from './dom';
import { Widget } from './widget';
import { i } from './icon';
import { Changes } from './changes';
import { MenuNavigation } from './menu-navigation';
import { Scrollbars } from './scrollbars';
import { bindKeys } from './keybindings';
import { Help } from './help';

export class Status extends Widget {

  readonly $menu: HTMLElement;
  readonly $image: HTMLElement;
  readonly changes: Changes;

  readonly branch$: ReactiveWritable<string | null>;
  readonly branches: HTMLElement[] = [];

  override initialize(this: Writable<this>): void {
    const $gitBranch = appendChild(this.parent, $('button.git-branch'));
    $gitBranch.type = 'button';
    $gitBranch.setAttribute('popovertarget', 'git-branch-menu');
    $gitBranch.setAttribute('aria-haspopup', 'menu');
    appendChild($gitBranch, i('source-control'));

    const $name = appendChild($gitBranch, $('span.git-branch-name'));
    const $loading = appendChild($gitBranch, i('loading'));
    $loading.style.display = 'none';

    const $menu = this.$menu = appendChild(this.parent, $('.git-branch-menu'));
    $menu.tabIndex = -1;
    $menu.setAttribute('role', 'menu');
    $menu.ariaLabel = 'Branches';
    $menu.popover = "";
    $menu.id = 'git-branch-menu';
    const $content = appendChild($menu, $('.menu-content'));
    this._register(new Scrollbars($content));

    for (const ref of this.root.git.refs) {
      if (ref.name && ref.name !== 'origin/HEAD') {
        const $branch = appendChild($content, $('.menu-item'));
        $branch.textContent = ref.name;
        $branch.tabIndex = -1;
        $branch.setAttribute('role', 'menuitem');
        this.branches.push($branch);
      }
    }

    let selection = 0;
    const select = async ($branch: HTMLElement) => {
      const refName = $branch.textContent;
      if (!refName) return;

      const request = ++selection;
      const loading = setTimeout(() => {
        if (request === selection) $loading.style.display = '';
      }, 100);
      this.branch$.set(refName);
      try {
        await this.root.git.goto(refName);
      } catch (error) {
        console.error(error);
      } finally {
        clearTimeout(loading);
        if (request === selection) $loading.style.display = 'none';
      }
    };

    $menu.onclick = e => {
      const $branch = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
      if ($branch) {
        void select($branch);
        this.closeBranches();
      }
    };
    $gitBranch.onclick = e => {
      e.preventDefault();
      if ($menu.matches(':popover-open')) this.closeBranches();
      else this.openBranches();
    };

    this._register(new MenuNavigation(
      $menu,
      this.branches,
      item => item.textContent || '',
      item => { void select(item); },
    ));
    // Handle the closing shortcut before menu typeahead.
    this._register(bindKeys($menu, {
      'Enter,Space': () => this.acceptBranch(select),
      'Escape,b': () => this.closeBranches(),
    }, true));

    this.changes = this._register(new Changes(appendChild(this.parent, $('.changes-detail')), this.root));

    appendChild(this.parent, $('.space'));
    const $pinned = appendChild(this.parent, $('.pinned'));
    this._register(onCustomEvent('pinned', e => {
      $pinned.textContent = e.detail ? 'Pinned.' : '';
    }));
    this._register(new Help(this.parent, this.root));
    this.$image = appendChild(this.parent, $('.image-status'));

    this.branch$ = this._register(writable<string | null>(this.root.git.head.name || this.root.git.head.commit?.slice(0, 7) || null));
    this._register(this.branch$.subscribe((branch) => {
      $name.textContent = branch;
    }));
  }

  acceptBranch(select: (branch: HTMLElement) => Promise<void>): void {
    const item = document.activeElement;
    if (item instanceof HTMLElement && this.branches.includes(item)) void select(item);
    this.closeBranches();
    this.root.commits.focus();
  }

  openBranches(): void {
    this.changes.close();
    this.$menu.showPopover();
    const branches = this.branches;
    const $branch = branches.find(branch => branch.textContent === this.branch$.value);
    ($branch || branches[0] || this.$menu).focus();
  }

  openChanges(): void {
    this.closeBranches();
    this.changes.open();
  }

  closeMenus(): void {
    this.root.editor.image?.closeMenu();
    this.closeBranches();
    this.changes.close();
  }

  closeBranches(): void {
    if (this.$menu.matches(':popover-open')) {
      const active = document.activeElement;
      this.$menu.hidePopover();
      if (active instanceof HTMLElement && this.$menu.contains(active)) active.blur();
    }
  }

  override layout(): void {
  }
}
