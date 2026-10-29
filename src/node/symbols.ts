import type { FileSymbols, SymbolQuery, SymbolResults, SymbolLocation } from '../common/symbols';

import ts from 'typescript';
import flru from 'flru';
import { SymbolAction, supportsSymbols } from '../common/symbols';
import { SnapshotFiles } from './snapshot-files';

interface SourceLines {
  readonly text: string;
  readonly starts: readonly number[];
}

interface Project {
  readonly service: ts.LanguageService;
  readonly roots: readonly string[];
}

interface SnapshotLanguageHost extends ts.LanguageServiceHost {
  // TypeScript 6 forwards this compiler host hook, but omits it from LanguageServiceHost.
  useSourceOfProjectReferenceRedirect(): boolean;
}

export class Symbols {
  private readonly projects: Project[] = [];
  private readonly cache = flru<SymbolResults>(100);
  private revision = -1;

  constructor(private readonly files: SnapshotFiles) { }

  dispose(): void {
    for (const project of this.projects) project.service.dispose();
    this.projects.length = 0;
    this.cache.clear(false);
  }

  query(query: SymbolQuery): SymbolResults {
    this.synchronize();
    if (query.file && this.files.contents(query.file).version !== query.version) return { locations: [], stale: true };
    const key = JSON.stringify([
      query.action, query.file?.source, query.file?.path, query.version,
      query.action === SymbolAction.FileSymbols ? 0 : query.position ?? 0,
    ]);
    let result = this.cache.get(key);
    if (!result) {
      result = query.action === SymbolAction.Index ? this.index() : this.search(query);
      this.cache.set(key, result);
    }
    return result;
  }

  private index(): SymbolResults {
    // Build and bind every project before accepting interactive symbol queries.
    for (const { service } of this.projects) service.getProgram()?.getTypeChecker();
    const files: FileSymbols[] = [];
    const roots = new Set<string>();
    for (const project of this.projects) {
      for (const file of project.roots) roots.add(file);
    }
    for (const file of roots) {
      if (!this.files.entries.has(file) || !supportsSymbols(file)) continue;
      const reference = this.files.reference(file);
      const version = this.files.version(file);
      const result = this.search({ action: SymbolAction.FileSymbols, file: reference, version });
      files.push({ ...reference, version, locations: result.locations });
    }
    return { ...this.search({ action: SymbolAction.WorkspaceSymbols }), files };
  }

  private search(query: SymbolQuery): SymbolResults {
    const files = this.files;
    const file = query.file ? files.absolute(query.file.path) : undefined;
    const locations = new Map<string, SymbolLocation>();
    const sources = new Map<string, SourceLines>();
    const add = (filename: string, span: ts.TextSpan, name: string, kind: string, container = '') => {
      const reference = files.reference(filename);
      const from = span.start, to = from + span.length;
      const key = `${reference.source}:${reference.path}:${from}:${to}`;
      if (locations.has(key)) return;
      let source = sources.get(filename);
      if (!source) {
        const text = files.readFile(filename);
        if (text == null) return;
        const starts = [0];
        for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
        source = { text, starts };
        sources.set(filename, source);
      }
      const { text, starts } = source;
      let low = 0, high = starts.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle] <= from) low = middle;
        else high = middle;
      }
      locations.set(key, {
        ...reference, from, to, version: files.version(filename), name, kind, container,
        line: low + 1,
        preview: text.slice(starts[low], starts[low + 1] == null ? text.length : starts[low + 1] - 1).trim(),
      });
    };
    if (query.action === SymbolAction.WorkspaceSymbols) {
      for (const { service } of this.projects) {
        for (const item of service.getNavigateToItems('', undefined, undefined, false, true)) {
          if (files.entries.has(item.fileName)) add(item.fileName, item.textSpan, item.name, item.kind, item.containerName);
        }
      }
    } else if (file) {
      const projects = this.projects.filter(project => project.service.getProgram()?.getSourceFile(file));
      if (query.action === SymbolAction.FileSymbols) {
        const visit = (item: ts.NavigationTree, container: string) => {
          for (const span of item.nameSpan ? [item.nameSpan] : item.spans) add(file, span, item.text, item.kind, container);
          for (const child of item.childItems ?? []) visit(child, container ? `${container}.${item.text}` : item.text);
        };
        const project = projects.find(project => project.roots.includes(file)) ?? projects[0];
        if (project) {
          for (const item of project.service.getNavigationTree(file).childItems ?? []) visit(item, '');
        }
      } else {
        const position = query.position ?? 0;
        const text = files.readFile(file) ?? '';
        if (!Number.isInteger(position) || position < 0 || position > text.length) throw new Error('Invalid symbol position');
        const definitions: ts.DefinitionInfo[] = [];
        for (const { service } of projects) definitions.push(...service.getDefinitionAndBoundSpan(file, position)?.definitions ?? []);
        if (query.action === SymbolAction.Definition) {
          for (const item of definitions) add(item.fileName, item.textSpan, item.name, item.kind, item.containerName);
        } else {
          const declarations = new Set<string>();
          const references: ts.ReferencedSymbolEntry[] = [];
          const key = (name: string, span: ts.TextSpan) => `${name}:${span.start}:${span.length}`;
          const targets = [{ fileName: file, textSpan: { start: position, length: 0 } }, ...definitions];
          for (const { service } of this.projects) {
            const visited = new Set<string>();
            for (const target of targets) {
              const id = key(target.fileName, target.textSpan);
              if (visited.has(id) || !service.getProgram()?.getSourceFile(target.fileName)) continue;
              visited.add(id);
              for (const group of service.findReferences(target.fileName, target.textSpan.start) ?? []) {
                declarations.add(key(group.definition.fileName, group.definition.textSpan));
                references.push(...group.references);
                if (query.action === SymbolAction.Related) {
                  const definition = group.definition;
                  add(definition.fileName, definition.textSpan, definition.name, definition.kind);
                }
              }
            }
          }
          if (query.action === SymbolAction.Related) {
            for (const item of definitions) {
              add(item.fileName, item.textSpan, item.name, item.kind, item.containerName);
            }
          }
          for (const item of references) {
            if (query.action === SymbolAction.References && (item.isDefinition || declarations.has(key(item.fileName, item.textSpan)))) continue;
            const name = files.readFile(item.fileName)?.slice(item.textSpan.start, item.textSpan.start + item.textSpan.length) ?? '';
            add(item.fileName, item.textSpan, name, item.isWriteAccess ? 'write' : 'reference');
          }
        }
      }
    }
    return { locations: [...locations.values()], stale: false };
  }

  private synchronize(): void {
    const files = this.files;
    files.prepare();
    if (this.revision === files.revision) return;
    this.dispose();
    const configs = [...files.entries.keys()].filter(file => /(?:^|[/\\])(?:tsconfig|jsconfig)\.json$/.test(file));
    const parsed = new Map<string, ts.ParsedCommandLine>();
    const parse = (file: string) => {
      if (parsed.has(file)) return;
      const config = ts.getParsedCommandLineOfConfigFile(file, {}, {
        readFile: files.readFile, fileExists: files.fileExists, readDirectory: files.readDirectory,
        getCurrentDirectory: () => files.repo.root, useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        onUnRecoverableConfigFileDiagnostic: diagnostic => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      });
      if (!config) return;
      const errors = config.errors.filter(error => error.code !== 18002 && error.code !== 18003);
      if (errors.length) throw new Error(ts.flattenDiagnosticMessageText(errors[0].messageText, '\n'));
      parsed.set(file, config);
      for (const reference of config.projectReferences ?? []) parse(ts.resolveProjectReferencePath(reference));
    };
    for (const config of configs) parse(config);
    const covered = new Set<string>();
    for (const config of parsed.values()) {
      if (!config.fileNames.length) continue;
      for (const file of config.fileNames) covered.add(file);
      this.addProject(config.fileNames, config.options, config.projectReferences);
    }
    const remaining = [...files.entries.keys()].filter(file => {
      return supportsSymbols(file) && !covered.has(file) && files.entries.get(file)?.mode !== '120000';
    });
    if (remaining.length) this.addProject(remaining, {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true, allowImportingTsExtensions: true, jsx: ts.JsxEmit.Preserve, noEmit: true, types: ['*'],
    });
    this.revision = files.revision;
  }

  private addProject(roots: string[], options: ts.CompilerOptions, references?: readonly ts.ProjectReference[]): void {
    const files = this.files;
    const host: SnapshotLanguageHost = {
      useSourceOfProjectReferenceRedirect: () => true,
      getCompilationSettings: () => options,
      getScriptFileNames: () => roots,
      getScriptVersion: file => files.version(file),
      getScriptSnapshot: file => {
        const text = files.readFile(file);
        return text == null ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => files.repo.root,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      getProjectReferences: () => references,
      readFile: files.readFile, fileExists: files.fileExists,
      directoryExists: files.directoryExists, getDirectories: files.getDirectories,
      readDirectory: files.readDirectory, realpath: files.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.projects.push({ roots, service: ts.createLanguageService(host) });
  }

}
