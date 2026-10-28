import type { LsTreeElement } from './git';
import type { Writable } from './base';

import { inertFilterMap } from '@wopjs/cast';

export interface Tree<Item> {
  readonly children: TreeNode<Item>[];
  readonly collapsible: boolean;
  readonly collapsed: boolean;
}

export interface TreeNode<Item> {
  readonly data: Item;
  readonly children: TreeNode<Item>[];
  readonly depth: number;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
}

export namespace Tree {

  export function flat<Item>(tree: Tree<Item>): TreeNode<Item>[] {
    if (tree.collapsed) return [];
    const list: TreeNode<Item>[] = [];
    const stack: TreeNode<Item>[] = tree.children.toReversed();
    while (stack.length) {
      const node = stack.pop()!;
      list.push(node);
      if (node.collapsible && !node.collapsed) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }
    return list;
  }

  export function dfs<Item>(tree: Tree<Item>, callback: (node: TreeNode<Item>) => void): void {
    const stack: TreeNode<Item>[] = tree.children.toReversed();
    while (stack.length) {
      const node = stack.pop()!;
      callback(node);
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }

  export function toggle<Item>(
    tree: Tree<Item>,
    filter?: (node: Tree<Item> | TreeNode<Item>) => unknown,
  ): Tree<Item> {
    if (!filter) {
      return { ...tree, collapsed: !tree.collapsed };
    }

    const children = inertFilterMap(tree.children, node => _toggle(node, filter));
    const collapsed = filter(tree) ? !tree.collapsed : tree.collapsed;
    if (children !== tree.children || collapsed !== tree.collapsed) {
      return { children, collapsible: tree.collapsible, collapsed };
    }

    return tree;
  }

  function _toggle<Item>(node: TreeNode<Item>, filter: (node: TreeNode<Item>) => unknown): TreeNode<Item> {
    const children = inertFilterMap(node.children, child => _toggle(child, filter));
    const collapsed = filter(node) ? !node.collapsed : node.collapsed;
    if (children !== node.children || collapsed !== node.collapsed) {
      return {
        data: node.data,
        children,
        depth: node.depth,
        collapsible: node.collapsible,
        collapsed,
      };
    }
    return node;
  }

}

// Git doesn't have a "folder" concept, so not need to check the blob type.
export function makeTree(elements: LsTreeElement[]): Tree<LsTreeElement> {
  const tree: Tree<LsTreeElement> = { children: [], collapsible: false, collapsed: false };

  for (const item of elements) {
    if (item.type === 'tree') {
      throw new Error('Unable to construct the files tree because "recursive" is not enabled.');
    }

    const parts = item.file.split('/');
    let current: Writable<Tree<LsTreeElement>> = tree, path = '', depth = 0;
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let child = current.children.find(e => e.data.file === path);
      if (!child) {
        const data: LsTreeElement = item.file === path ? item : {
          mode: '0', type: 'tree', object: '', size: '-', file: path
        };
        child = { data, children: [], depth, collapsible: false, collapsed: true };
        current.children.push(child);
        current.collapsible = true;
      }
      current = child;
      depth++;
    }
  }
  sortTree(tree);

  return tree;
}

function sortTree(tree: Tree<LsTreeElement>) {
  tree.children.sort(compareTreeNode);
  for (const child of tree.children) {
    sortTree(child);
  }
}

const collator = new Intl.Collator(undefined, { numeric: true });

function compareTreeNode(a: TreeNode<LsTreeElement>, b: TreeNode<LsTreeElement>): number {
  // Sort folders first.
  if (a.children.length > 0 && b.children.length === 0) return -1;
  if (a.children.length === 0 && b.children.length > 0) return 1;

  return collator.compare(a.data.file, b.data.file);
}
