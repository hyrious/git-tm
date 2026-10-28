import type { Disposer } from '@wopjs/disposable';

export interface Keybinding {
  /** Repeated keydowns are consumed without running unless enabled. */
  readonly repeat?: boolean;
  readonly when?: (event: KeyboardEvent) => boolean;
  readonly run: (event: KeyboardEvent) => void;
}

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

export function onKeyDown(target: HTMLElement | Window, handler: (event: KeyboardEvent) => boolean, capture = false): Disposer {
  const listener = (event: Event) => {
    const e = event as KeyboardEvent;
    if (e.defaultPrevented || e.isComposing) return;
    if (handler(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  target.addEventListener('keydown', listener, capture);
  return () => target.removeEventListener('keydown', listener, capture);
}

/** Comma-separated keys with optional Mod+ and Shift+ prefixes. Mod is Command on macOS, Control elsewhere. */
export function bindKeys(target: HTMLElement | Window, bindings: Readonly<Record<string, Keybinding | Keybinding['run']>>, capture = false): Disposer {
  const entries = Object.entries(bindings).flatMap(([keys, binding]) => keys.split(',').map(shortcut => {
    const parts = shortcut.trim().split('+');
    const name = parts.pop()!;
    const mod = parts.includes('Mod');
    const shift = parts.includes('Shift');
    const key = name === 'Space' ? ' ' : mod ? name.toLowerCase() : name;
    return { key, mod, shift, binding: typeof binding === 'function' ? { run: binding } : binding };
  }));
  return onKeyDown(target, e => {
    for (const { key: expected, mod, shift, binding } of entries) {
      if (e.altKey || e.ctrlKey != (mod && !mac) || e.metaKey != (mod && mac) || e.shiftKey != shift) continue;
      const key = mod ? e.key.toLowerCase() : e.key;
      if (key != expected) continue;
      if (binding.when && !binding.when(e)) continue;
      if (!e.repeat || binding.repeat) binding.run(e);
      return true;
    }
    return false;
  }, capture);
}
