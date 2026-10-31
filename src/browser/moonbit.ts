import type { StreamParser } from '@codemirror/language';
import type { Tag } from '@lezer/highlight';

import { LanguageSupport, StreamLanguage } from '@codemirror/language';
import { tags } from '@lezer/highlight';

interface MoonBitState {
  inBlockComment: boolean;
}

const keywords = new Set([
  'as', 'async', 'break', 'catch', 'const', 'continue', 'derive', 'elif', 'else', 'enum',
  'extern', 'fn', 'for', 'fnalias', 'guard', 'if', 'impl', 'import', 'in', 'init', 'is',
  'let', 'loop', 'match', 'mut', 'open', 'package', 'priv', 'pub', 'raise', 'return',
  'static', 'struct', 'suberror', 'test', 'throw', 'trait', 'try', 'type', 'typealias',
  'using', 'while', 'with', '__attribute__',
]);

const literals = new Set(['true', 'false', 'self']);

const types = new Set([
  'Bool', 'Byte', 'Bytes', 'Char', 'Double', 'Error', 'Failure', 'FixedArray', 'Float',
  'Int', 'Int16', 'Int64', 'Iter', 'Iter2', 'IterResult', 'Map', 'Option', 'Result', 'Set',
  'String', 'UInt', 'UInt16', 'UInt64', 'Unit', 'Array', 'ArrayView',
]);

const tokenTable: Record<string, Tag> = {
  annotation: tags.annotation,
  attribute: tags.attributeName,
  char: tags.character,
  macroName: tags.macroName,
  number: tags.number,
};

const parser: StreamParser<MoonBitState> = {
  name: 'moonbit',
  startState: () => ({ inBlockComment: false }),
  copyState: state => ({ ...state }),
  tokenTable,
  token(stream, state) {
    if (state.inBlockComment) {
      let depth = 1;
      while (depth > 0 && !stream.eol()) {
        if (stream.match('/*')) depth++;
        else if (stream.match('*/')) depth--;
        else stream.next();
      }
      state.inBlockComment = depth > 0;
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      let depth = 1;
      while (depth > 0 && !stream.eol()) {
        if (stream.match('/*')) depth++;
        else if (stream.match('*/')) depth--;
        else stream.next();
      }
      state.inBlockComment = depth > 0;
      return 'comment';
    }
    if (stream.match(/^#!?[A-Za-z_][\w.]*/)) return 'attribute';
    if (stream.match(/^[rub]?"/)) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '\\') stream.next();
        else if (ch === '"') break;
      }
      return 'string';
    }
    if (stream.match(/^b?'(?:\\[\s\S]|[^'\\])'/)) return 'char';
    if (stream.match(/^0[xX][\da-fA-F_]+[uUlL]?/) || stream.match(/^0[bB][01_]+[uUlL]?/)
      || stream.match(/^0[oO][0-7_]+[uUlL]?/) || stream.match(/^\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[uUlLfF]?/)) {
      return 'number';
    }
    if (stream.match(/^@[A-Za-z_]\w*/)) return 'namespace';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current();
      if (keywords.has(word)) return 'keyword';
      if (literals.has(word)) return 'atom';
      if (types.has(word) || /^[A-Z]/.test(word)) return 'typeName';
      if (stream.peek() === '!') return 'macroName';
      return 'variableName';
    }
    stream.next();
    return null;
  },
};

export const moonbit = new LanguageSupport(StreamLanguage.define(parser));
