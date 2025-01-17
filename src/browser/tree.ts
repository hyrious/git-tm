import { inertFilterMap } from '../base';

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

  function _toggle<Item>(
    node: TreeNode<Item>,
    filter: (node: TreeNode<Item>) => unknown,
  ): TreeNode<Item> {

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
