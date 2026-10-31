import type { EditorState } from '@codemirror/state';
import type { FileReference, SymbolLocation } from '../common/symbols';

import { DocInput, LanguageDescription, StreamLanguage, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { languages } from './languages';
import { getStyleTags, Tag, tags } from '@lezer/highlight';

/** Extract declarations identified by the language's highlighting metadata. */
export async function syntaxSymbols(file: FileReference, state: EditorState, version: string | undefined, active: () => boolean): Promise<SymbolLocation[]> {
  const description = LanguageDescription.matchFilename(languages, file.path);
  if (!description) return [];
  const support = await description.load();
  if (!active() || support.language instanceof StreamLanguage) return [];
  let tree = syntaxTreeAvailable(state) ? syntaxTree(state) : undefined;
  if (!tree) {
    const parse = support.language.parser.startParse(new DocInput(state.doc));
    let deadline = performance.now() + 8;
    while (active()) {
      const result = parse.advance();
      if (result) { tree = result; break; }
      if (performance.now() >= deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        deadline = performance.now() + 8;
      }
    }
  }
  if (!tree || !active()) return [];
  const result: SymbolLocation[] = [];
  tree.iterate({
    enter(node) {
      const style = getStyleTags(node);
      if (!style?.tags.some(tag => tag.set.includes(tags.definition(tags.name)))) return;
      const has = (tag: Tag) => style.tags.some(value => value.set.includes(tags.definition(tag)));
      let kind = 'var';
      if (has(tags.className)) {
        kind = 'class';
      } else if (has(tags.typeName)) {
        kind = 'type';
      } else if (has(tags.function(tags.variableName))) {
        kind = 'function';
      } else if (has(tags.propertyName)) {
        kind = 'property';
      }
      const name = state.sliceDoc(node.from, node.to);
      if (!name) return;
      const line = state.doc.lineAt(node.from);
      result.push({ ...file, from: node.from, to: node.to, version, name, kind, container: '', line: line.number, preview: line.text.trim() });
    }
  });
  return result;
}
