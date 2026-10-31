import type { Writable } from '../common/base';

import { writable, type Writable as ReactiveWritable } from '@embra/reactivity';
import { appendChild } from '@wopjs/dom';
import { $, onCustomEvent } from './dom';
import { Widget } from './widget';
import { i } from './icon';
import { Changes } from './changes';
import { MenuNavigation } from './menu-navigation';
import { Popover } from './popover';
import { Scrollbars } from './scrollbars';
import { bindKeys } from './keybindings';
import { Help } from './help';

export class Status extends Widget {

  readonly $menu: HTMLElement;
  readonly $image: HTMLElement;

  readonly popover: Popover;
  readonly changes: Changes;
  readonly branches: HTMLElement[] = [];

  readonly branch$: ReactiveWritable<string | null>;

  override initialize(this: Writable<this>): void {
    const $gitBranch = appendChild(this.parent, $('button.git-branch'));
    $gitBranch.type = 'button';
    $gitBranch.setAttribute('popovertarget', 'git-branch-menu');
    $gitBranch.setAttribute('aria-haspopup', 'menu');
    $gitBranch.setAttribute('aria-keyshortcuts', 'b');
    appendChild($gitBranch, i('source-control'));

    const $name = appendChild($gitBranch, $('span.git-branch-name'));

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

    const select = async ($branch: HTMLElement) => {
      const refName = $branch.textContent;
      if (!refName) return;

      this.branch$.set(refName);
      try {
        await this.root.git.goto(refName);
      } catch (error) {
        console.error(error);
      }
    };

    $menu.onclick = e => {
      const $branch = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
      if ($branch) {
        void select($branch);
        this.closeBranches(true);
      }
    };

    this.popover = this._register(new Popover({
      $button: $gitBranch,
      $menu,
      shortcut: 'b',
      focus: () => {
        const branches = this.branches;
        return branches.find(branch => branch.textContent === this.branch$.value) || branches[0];
      },
    }));

    this._register(new MenuNavigation(
      $menu,
      this.branches,
      item => item.textContent || '',
      item => { void select(item); },
    ));
    this._register(bindKeys($menu, {
      'Enter,Space': () => this.acceptBranch(select),
    }, true));

    this.changes = this._register(new Changes(appendChild(this.parent, $('.changes-detail')), this.root));

    const $indexing = appendChild(this.parent, $('.indexing-status'));
    $indexing.setAttribute('role', 'status');
    this._register(this.root.symbolIndex.progress$.subscribe(percent => {
      $indexing.hidden = percent === null;
      if (percent === null) {
        $indexing.textContent = '';
      } else if (percent === undefined) {
        $indexing.textContent = 'Indexing…';
      } else {
        $indexing.textContent = `Indexing… ${percent}%`;
      }
    }));

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
    this.popover.reveal();
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

  closeBranches(focus = false): void {
    this.popover.close(focus);
  }

  override layout(): void {
  }
}
