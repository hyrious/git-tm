import type { Extension } from '@codemirror/state';

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

function modern(dark: boolean): Extension {
  const foreground = dark ? '#CCCCCC' : '#3B3B3B';
  const background = dark ? '#1F1F1F' : '#FFFFFF';
  const selection = dark ? '#264F78' : '#ADD6FF';
  const keyword = dark ? '#569CD6' : '#0000FF';
  const type = dark ? '#4EC9B0' : '#267F99';
  const variable = dark ? '#9CDCFE' : '#001080';
  const string = dark ? '#CE9178' : '#A31515';
  const theme = EditorView.theme({
    '&': { color: foreground, backgroundColor: background, fontSize: '12px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': { caretColor: foreground, cursor: 'text' },
    '.cm-content:focus': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, monospace', lineHeight: '1.5' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: foreground },
    '.cm-selectionBackground': { backgroundColor: dark ? '#3A3D41' : '#E5EBF1' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': { backgroundColor: selection },
    '.cm-activeLine': { backgroundColor: dark ? '#FFFFFF06' : '#00000004' },
    '.cm-gutters': { backgroundColor: background, color: '#6E7681', border: 'none' },
    '.cm-activeLineGutter': { color: foreground, backgroundColor: 'transparent' },
    '.cm-foldGutter': { font: 'normal normal normal 14px/1 codicon' },
    '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center' },
    '.cm-foldPlaceholder': { backgroundColor: 'transparent', color: foreground, border: 'none' },
    '.cm-matchingBracket': { backgroundColor: '#0064001A', outline: '1px solid #888888' },
    '.cm-searchMatch': { backgroundColor: dark ? '#EA5C0055' : '#EA5C0033' },
    '.cm-searchMatch-selected': { backgroundColor: dark ? '#515C6A' : '#A8AC94' },
    '.cm-panels, .cm-tooltip': { color: foreground, backgroundColor: dark ? '#252526' : '#F8F8F8' },
    '.cm-deletedChunk': { backgroundColor: dark ? '#FF000033' : '#FF000026' },
    '&.cm-merge-b .cm-changedLine': { backgroundColor: '#9BB95533' },
    '.cm-deletedChunk .cm-deletedText': { backgroundColor: '#FF000033', backgroundImage: 'none' },
    '&.cm-merge-b .cm-changedText': { backgroundColor: dark ? '#9CCC2C33' : '#9CCC2C66', backgroundImage: 'none' },
  }, { dark });
  const highlight = HighlightStyle.define([
    { tag: t.comment, color: dark ? '#6A9955' : '#008000' },
    { tag: [t.keyword, t.modifier, t.self, t.bool, t.null], color: keyword },
    { tag: [t.controlKeyword, t.moduleKeyword], color: dark ? '#C586C0' : '#AF00DB' },
    { tag: [t.string, t.attributeValue], color: string },
    { tag: [t.regexp, t.escape], color: dark ? '#D16969' : '#811F3F' },
    { tag: t.number, color: dark ? '#B5CEA8' : '#098658' },
    { tag: [t.variableName, t.propertyName], color: variable },
    { tag: [t.typeName, t.className, t.namespace], color: type },
    { tag: t.function(t.variableName), color: dark ? '#DCDCAA' : '#795E26' },
    { tag: t.function(t.propertyName), color: dark ? '#DCDCAA' : '#795E26' },
    { tag: t.tagName, color: dark ? '#569CD6' : '#800000' },
    { tag: t.attributeName, color: dark ? '#9CDCFE' : '#E50000' },
    { tag: t.operator, color: dark ? '#D4D4D4' : '#000000' },
    { tag: [t.heading, t.strong], fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: string, textDecoration: 'underline' },
    { tag: t.invalid, color: '#F44747' },
  ]);
  return [theme, syntaxHighlighting(highlight)];
}

export const modernLight = modern(false);
export const modernDark = modern(true);
