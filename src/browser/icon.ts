import { element } from '@wopjs/dom';

export function i(name: string): HTMLElement {
  const i = element('i');
  i.className = ic(name);
  return i;
}

export function ic(name: string): string {
  return 'codicon codicon-' + name;
}
