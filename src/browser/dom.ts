// Source taken from VS Code's vs/base/browser/dom.ts.
import type { Disposer } from "@wopjs/disposable";

type HTMLElementAttributeKeys<T> = Partial<{ [K in keyof T]: T[K] extends Function ? never : T[K] extends object ? HTMLElementAttributeKeys<T[K]> : T[K] }>;
type ElementAttributes<T> = HTMLElementAttributeKeys<T> & Record<string, any>;
type RemoveHTMLElement<T> = T extends HTMLElement ? never : T;
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;
type ArrayToObj<T extends readonly any[]> = UnionToIntersection<RemoveHTMLElement<T[number]>>;
type HHTMLElementTagNameMap = HTMLElementTagNameMap & { '': HTMLDivElement; };

type TagToElement<T> = T extends `${infer TStart}#${string}`
  ? TStart extends keyof HHTMLElementTagNameMap
  ? HHTMLElementTagNameMap[TStart]
  : HTMLElement
  : T extends `${infer TStart}.${string}`
  ? TStart extends keyof HHTMLElementTagNameMap
  ? HHTMLElementTagNameMap[TStart]
  : HTMLElement
  : T extends keyof HTMLElementTagNameMap
  ? HTMLElementTagNameMap[T]
  : HTMLElement;

type TagToElementAndId<TTag> = TTag extends `${infer TTag}@${infer TId}`
  ? { element: TagToElement<TTag>; id: TId; }
  : { element: TagToElement<TTag>; id: 'root'; };

type TagToRecord<TTag> = TagToElementAndId<TTag> extends { element: infer TElement; id: infer TId; }
  ? Record<(TId extends string ? TId : never) | 'root', TElement>
  : never;

type Child = HTMLElement | string | Record<string, HTMLElement>;

// div#id.class1.class2@name
const H_REGEX = /(?<tag>[\w\-]+)?(?:#(?<id>[\w\-]+))?(?<class>(?:\.(?:[\w\-]+))*)(?:@(?<name>(?:[\w\_])+))?/;

/**
 * A helper function to create nested dom nodes.
 *
 * ```ts
 * const elements = h('div.code-view', [
 * 	h('div.title@title'),
 * 	h('div.container', [
 * 		h('div.gutter@gutterDiv'),
 * 		h('div@editor'),
 * 	]),
 * ]);
 * const editor = createEditor(elements.editor);
 * ```
*/
export function h<TTag extends string>
  (tag: TTag):
  TagToRecord<TTag> extends infer Y ? { [TKey in keyof Y]: Y[TKey] } : never;

export function h<TTag extends string, T extends Child[]>
  (tag: TTag, children: [...T]):
  (ArrayToObj<T> & TagToRecord<TTag>) extends infer Y ? { [TKey in keyof Y]: Y[TKey] } : never;

export function h<TTag extends string>
  (tag: TTag, attributes: Partial<ElementAttributes<TagToElement<TTag>>>):
  TagToRecord<TTag> extends infer Y ? { [TKey in keyof Y]: Y[TKey] } : never;

export function h<TTag extends string, T extends Child[]>
  (tag: TTag, attributes: Partial<ElementAttributes<TagToElement<TTag>>>, children: [...T]):
  (ArrayToObj<T> & TagToRecord<TTag>) extends infer Y ? { [TKey in keyof Y]: Y[TKey] } : never;

export function h(tag: string, ...args: [] | [attributes: { $: string; } & Partial<ElementAttributes<HTMLElement>> | Record<string, any>, children?: any[]] | [children: any[]]): Record<string, HTMLElement> {
  let attributes: { $?: string; } & Partial<ElementAttributes<HTMLElement>>;
  let children: (Record<string, HTMLElement> | HTMLElement)[] | undefined;

  if (Array.isArray(args[0])) {
    attributes = {};
    children = args[0];
  } else {
    attributes = args[0] as any || {};
    children = args[1];
  }

  const match = H_REGEX.exec(tag);

  if (!match || !match.groups) {
    throw new Error('Bad use of h');
  }

  const tagName = match.groups['tag'] || 'div';
  const el = document.createElement(tagName);

  if (match.groups['id']) {
    el.id = match.groups['id'];
  }

  const classNames: string[] = [];
  if (match.groups['class']) {
    for (const className of match.groups['class'].split('.')) {
      if (className !== '') {
        classNames.push(className);
      }
    }
  }
  if (attributes.className !== undefined) {
    for (const className of attributes.className.split('.')) {
      if (className !== '') {
        classNames.push(className);
      }
    }
  }
  if (classNames.length > 0) {
    el.className = classNames.join(' ');
  }

  const result: Record<string, HTMLElement> = {};

  if (match.groups['name']) {
    result[match.groups['name']] = el;
  }

  if (children) {
    for (const c of children) {
      if (isHTMLElement(c)) {
        el.appendChild(c);
      } else if (typeof c === 'string') {
        el.append(c);
      } else if ('root' in c) {
        Object.assign(result, c);
        el.appendChild(c.root);
      }
    }
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') {
      continue;
    } else if (key === 'style') {
      for (const [cssKey, cssValue] of Object.entries(value)) {
        el.style.setProperty(
          camelCaseToHyphenCase(cssKey),
          typeof cssValue === 'number' ? cssValue + 'px' : '' + cssValue
        );
      }
    } else if (key === 'tabIndex') {
      el.tabIndex = value;
    } else {
      el.setAttribute(camelCaseToHyphenCase(key), value.toString());
    }
  }

  result['root'] = el;

  return result;
}

function camelCaseToHyphenCase(str: string) {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function isHTMLElement(node: any): node is HTMLElement {
  return node instanceof HTMLElement;
}

export function $<T extends string>(tag: T): TagToElement<T> {
  const match = H_REGEX.exec(tag);

  if (!match || !match.groups) {
    throw new Error('Bad use of h');
  }

  const tagName = match.groups['tag'] || 'div';
  const el = document.createElement(tagName);

  if (match.groups['id']) {
    el.id = match.groups['id'];
  }

  const classNames: string[] = [];
  if (match.groups['class']) {
    for (const className of match.groups['class'].split('.')) {
      if (className !== '') {
        classNames.push(className);
      }
    }
  }

  if (classNames.length > 0) {
    el.className = classNames.join(' ');
  }

  return el as TagToElement<T>;
}

export function clearElement(element: HTMLElement): void {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

export function onCustomEvent<T>(name: string, callback: (ev: CustomEvent<T>) => void): Disposer {
  window.addEventListener(name as any, callback);
  return () => window.removeEventListener(name as any, callback);
}
