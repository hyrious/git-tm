// Source taken from VS Code's vs/base/browser/dom.ts.
import type { Disposer } from "@wopjs/disposable";

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

// div#id.class1.class2@name
const H_REGEX = /(?<tag>[\w\-]+)?(?:#(?<id>[\w\-]+))?(?<class>(?:\.(?:[\w\-]+))*)(?:@(?<name>(?:[\w\_])+))?/;

export function $<T extends string>(tag: T): TagToElement<T> {
  const match = H_REGEX.exec(tag);

  if (!match || !match.groups) {
    throw new Error('Invalid element selector');
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
