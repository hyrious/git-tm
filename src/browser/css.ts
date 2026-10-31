import { batch, combine, reactiveMap } from '@embra/reactivity';
import { isTruthy } from '@wopjs/cast';
import { Disposable } from '../common/disposable';

class StyleMod extends Disposable {

  private readonly sheet = new CSSStyleSheet();
  private readonly staticRules = this._register(reactiveMap<string, string>());
  private readonly dynamicRules = this._register(reactiveMap<string, string>());

  constructor() {
    super();
    document.adoptedStyleSheets = [this.sheet];
    this._register(combine([this.staticRules.$, this.dynamicRules.$]).subscribe(([map, map2]) => {
      let code = Array.from(map.values()).join('\n');
      for (let a of map2.values()) if (a) {
        code += '\n' + a;
      }
      this.sheet.replaceSync(code);
    }));
  }

  set(selector: string, spec: { [prop: string]: string | number; }) {
    this.staticRules.set(selector, _stringify(selector, spec));
  }

  derive(id: string) {
    const set = (sheet: { [selector: string]: { [prop: string]: string | number; } | null; }) => {
      const rules = Object.entries(sheet)
        .map(([sel, spec]) => spec && _stringify(sel, spec))
        .filter(isTruthy)
        .join('\n');
      this.dynamicRules.set(id, rules);
    };
    const dispose = () => {
      batch(() => this.dynamicRules.delete(id));
    };
    return { set, dispose };
  }

  override dispose() {
    super.dispose();
    document.adoptedStyleSheets = [];
  }
}

function _stringify(selector: string, spec: { [prop: string]: string | number; }) {
  const local: string[] = [];
  for (const prop in spec) {
    const value = spec[prop];
    local.push(prop.replace(/_.*/, '').replace(/[A-Z]/g, l => '-' + l.toLowerCase()) + ': ' + value + ';');
  }
  return selector + ' {' + local.join(' ') + '}';
}

export const styleMod = new StyleMod();

styleMod.set('body', { fontFamily: getSansFontFamily() });
styleMod.set('pre, code', { fontFamily: getMonoFontFamily() });

function getSansFontFamily(): string {
  const language = navigator.language;
  const zhHans = language.toLowerCase() === 'zh-cn';
  const zhHant = language.toLowerCase() === 'zh-tw';

  if (/Mac/.test(navigator.platform)) {
    if (zhHans) {
      return '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif';
    } else if (zhHant) {
      return '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    } else {
      return '-apple-system, BlinkMacSystemFont, sans-serif';
    }
  } else if (/Win/.test(navigator.platform)) {
    if (zhHans) {
      return '"Segoe WPC", "Segoe UI", "Microsoft YaHei", sans-serif';
    } else if (zhHant) {
      return '"Segoe WPC", "Segoe UI", "Microsoft JhengHei", sans-serif';
    } else {
      return '"Segoe WPC", "Segoe UI", sans-serif';
    }
  } else {
    if (zhHans) {
      return 'system-ui, "Ubuntu", "Droid Sans", "Source Han Sans SC", "Source Han Sans CN", "Source Han Sans", sans-serif';
    } else if (zhHant) {
      return 'system-ui, "Ubuntu", "Droid Sans", "Source Han Sans TC", "Source Han Sans TW", "Source Han Sans", sans-serif';
    } else {
      return 'system-ui, "Ubuntu", "Droid Sans", sans-serif';
    }
  }
}

function getMonoFontFamily(): string {
  if (/Mac/.test(navigator.platform)) {
    return 'Menlo, Monaco, "Courier New", monospace';
  } else if (/Win/.test(navigator.platform)) {
    return '"Cascadia Code", Consolas, "Courier New", monospace';
  } else {
    return '"Droid Sans Mono", "monospace", monospace';
  }
}
