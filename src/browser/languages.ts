import type { LanguageSupport } from '@codemirror/language';

import { LanguageDescription, LanguageSupport as LanguageSupportClass, StreamLanguage } from '@codemirror/language';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { json } from '@codemirror/lang-json';
import { less } from '@codemirror/lang-less';
import { markdown } from '@codemirror/lang-markdown';
import { nushell } from '@codincod/codemirror-lang-nushell';
import { sass } from '@codemirror/lang-sass';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { languages as builtin } from '@codemirror/language-data';
import { moonbit } from './moonbit';

let js: LanguageSupport | undefined, ts: LanguageSupport | undefined;
let jsx: LanguageSupport | undefined, tsx: LanguageSupport | undefined;

/**
 * `@codemirror/language-data` covers most languages. This list adds the ones
 * it misses and overrides the ones mapped to a less specific mode.
 */
const extra: readonly LanguageDescription[] = [
  LanguageDescription.of({ name: 'CMake', extensions: ['cmake'], support: new LanguageSupportClass(StreamLanguage.define(cmake)) }),
  LanguageDescription.of({ name: 'CSS', extensions: ['css'], support: css() }),
  LanguageDescription.of({ name: 'Dockerfile', extensions: ['dockerfile'], support: new LanguageSupportClass(StreamLanguage.define(dockerFile)) }),
  LanguageDescription.of({ name: 'Go', extensions: ['go'], support: go() }),
  LanguageDescription.of({ name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'], alias: ['ecmascript', 'node'], load: async () => js ??= javascript() }),
  LanguageDescription.of({ name: 'JSON', extensions: ['json', 'jsonc', 'json5', 'map'], alias: ['json5'], support: json() }),
  LanguageDescription.of({ name: 'JSX', extensions: ['jsx'], load: async () => jsx ??= javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'Less', extensions: ['less'], support: less() }),
  LanguageDescription.of({ name: 'Lua', extensions: ['lua'], support: new LanguageSupportClass(StreamLanguage.define(lua)) }),
  LanguageDescription.of({ name: 'Markdown', extensions: ['md', 'markdown', 'mkd'], support: markdown() }),
  LanguageDescription.of({ name: 'MoonBit', extensions: ['mbt', 'mbti'], filename: /^moon\.(?:pkg|mod)$/, support: moonbit }),
  LanguageDescription.of({ name: 'Nushell', extensions: ['nu'], support: nushell() }),
  LanguageDescription.of({ name: 'Sass', extensions: ['sass'], support: sass({ indented: true }) }),
  LanguageDescription.of({ name: 'SCSS', extensions: ['scss'], support: sass({ indented: false }) }),
  LanguageDescription.of({ name: 'SQL', extensions: ['sql'], support: sql() }),
  LanguageDescription.of({ name: 'TSX', extensions: ['tsx'], load: async () => tsx ??= javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: 'TypeScript', extensions: ['ts', 'mts', 'cts'], alias: ['ts'], load: async () => ts ??= javascript({ typescript: true }) }),
  LanguageDescription.of({ name: 'XML', extensions: ['xml', 'xsl', 'xsd', 'svg'], support: xml() }),
  LanguageDescription.of({ name: 'YAML', extensions: ['yaml', 'yml'], support: yaml() }),
];

export const languages: readonly LanguageDescription[] = [...extra, ...builtin];
