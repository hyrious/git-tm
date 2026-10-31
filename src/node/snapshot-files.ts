import type { LsTreeElement } from '../common/git';
import type { FileReference, FileContents } from '../common/symbols';

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Repository } from './repository';
import { FileSource, supportsSymbols } from '../common/symbols';
import { decodeText } from '../common/base';

interface CachedFile {
  readonly bytes: Buffer;
  readonly text: string;
  readonly version: string;
}

/** The editor and language service read the same versioned files. */
export class SnapshotFiles {
  readonly library = path.dirname(createRequire(import.meta.url).resolve('typescript'));
  readonly entries = new Map<string, LsTreeElement>();
  revision = 0;

  private readonly files = new Map<string, CachedFile>();
  private readonly external = new Map<string, CachedFile>();
  private readonly directories = new Set<string>();
  private ref: string | undefined;
  private initialized = false;

  constructor(readonly repo: Repository) { }

  async select(ref: string | undefined, refresh = false): Promise<void> {
    if (ref && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) {
      ref = (await this.repo.exec(['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`])).stdout.trim();
    }
    if (this.initialized && this.ref === ref && (ref || !refresh)) return;
    const entries = ref ? await this.repo.lstree(ref, { recursive: true }) : await this.repo.workingTree();
    if (!this.initialized || this.ref !== ref) {
      this.files.clear();
      this.revision++;
    }
    this.initialized = true;
    this.ref = ref;
    const next = new Map(entries.map(entry => [this.absolute(entry.file), entry]));
    if (next.size !== this.entries.size
      || [...next].some(([file, entry]) => this.entries.get(file)?.object !== entry.object)) {
      this.revision++;
    }
    for (const file of this.files.keys()) {
      if (!next.has(file)) {
        this.files.delete(file);
        this.revision++;
      }
    }
    this.entries.clear();
    this.directories.clear();
    this.directories.add(this.repo.root);
    for (const [file, entry] of next) {
      this.entries.set(file, entry);
      for (let dir = path.dirname(file); this.inside(dir); dir = path.dirname(dir)) {
        if (this.directories.has(dir)) break;
        this.directories.add(dir);
      }
    }
  }

  prepare(): void {
    const sources = [...this.entries].filter(([, entry]) => {
      if (entry.type !== 'blob' || entry.mode === '120000') return false;
      return supportsSymbols(entry.file) || entry.file.endsWith('.json');
    });
    if (this.ref) {
      const missing = sources.filter(([file]) => !this.files.has(file));
      if (missing.length) {
        const data = execFileSync('git', ['cat-file', '--batch'], {
          cwd: this.repo.root, input: missing.map(([, entry]) => entry.object).join('\n') + '\n',
          maxBuffer: 256 * 1024 * 1024,
        });
        let offset = 0;
        for (const [file, entry] of missing) {
          const end = data.indexOf(10, offset);
          const header = data.toString('utf8', offset, end).split(' ');
          if (header[1] !== 'blob') throw new Error('Could not read snapshot');
          const size = Number(header[2]);
          const bytes = Buffer.from(data.subarray(end + 1, end + 1 + size));
          this.files.set(file, { bytes, text: decodeText(bytes), version: entry.object });
          offset = end + 1 + size + 1;
        }
      }
    } else {
      for (const [file] of sources) this.read(file, true);
    }
    for (const file of this.external.keys()) this.read(file, true);
  }

  absolute(file: string): string { return path.resolve(this.repo.root, file); }

  private inside(file: string): boolean {
    return file === this.repo.root || file.startsWith(this.repo.root + path.sep);
  }

  /** A path is visible when the snapshot tracks it or it is an allowed dependency. */
  private canAccess(file: string): boolean {
    file = normalize(file);
    return this.entries.has(file) || this.directories.has(file) || this.diskAllowed(file);
  }

  private diskEntries(dir: string): fs.Dirent[] {
    if (!this.diskAllowed(dir)) return [];
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private diskAllowed(file: string): boolean {
    if (file.startsWith(this.library + path.sep) || file === this.library) return true;
    if (this.inside(file) && path.relative(this.repo.root, file).split(path.sep).includes('node_modules')) return true;
    for (let dir = this.repo.root; ; dir = path.dirname(dir)) {
      const modules = path.join(dir, 'node_modules');
      if (file === modules || file.startsWith(modules + path.sep)) return true;
      if (path.dirname(dir) === dir) return false;
    }
  }

  private workingBytes(file: string): Buffer | undefined {
    const parts = path.relative(this.repo.root, file).split(path.sep);
    let current = this.repo.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return;
    }
    return fs.lstatSync(file).isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
  }

  private read(file: string, refresh = false): CachedFile | undefined {
    file = this.realpath(path.resolve(file));
    const entry = this.entries.get(file);
    const cache = entry ? this.files : this.external;
    const previous = cache.get(file);
    if (previous && (!refresh || entry && this.ref)) return previous;
    if (!entry && !this.diskAllowed(file)) return;
    let bytes: Buffer | undefined;
    try {
      if (!entry) {
        bytes = fs.readFileSync(file);
      } else if (this.ref) {
        bytes = execFileSync('git', ['cat-file', 'blob', entry.object], {
          cwd: this.repo.root,
          maxBuffer: 256 * 1024 * 1024,
        });
      } else {
        bytes = this.workingBytes(file);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'EISDIR') throw error;
    }
    if (!bytes) {
      if (cache.delete(file)) this.revision++;
      return;
    }
    if (previous?.bytes.equals(bytes)) return previous;
    const version = entry && this.ref ? entry.object : createHash('sha256').update(bytes).digest('hex');
    const result = { bytes, text: decodeText(bytes), version };
    cache.set(file, result);
    if (previous || entry && !this.ref) this.revision++;
    return result;
  }

  contents(reference: FileReference): FileContents {
    const file = this.absolute(reference.path);
    const entries = reference.source === FileSource.Snapshot ? this.entries : this.external;
    if (!entries.has(file)) throw new Error('File not found');
    const result = this.read(file, true);
    if (!result) throw new Error('File not found');
    return { bytes: result.bytes, version: result.version };
  }

  reference(file: string): FileReference {
    file = this.realpath(file);
    return {
      source: this.entries.has(file) ? FileSource.Snapshot : FileSource.External,
      path: path.relative(this.repo.root, file).split(path.sep).join('/'),
    };
  }

  version(file: string): string {
    file = this.realpath(file);
    return this.files.get(file)?.version ?? this.external.get(file)?.version ?? '';
  }
  readFile = (file: string): string | undefined => this.read(file)?.text;
  fileExists = (file: string): boolean => {
    // Package resolution probes directories such as `node_modules/@scope` through `fileExists`.
    return this.canAccess(file) && fs.existsSync(file);
  };
  directoryExists = (dir: string): boolean => {
    return this.canAccess(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  };
  realpath = (file: string): string => {
    if (this.canAccess(file)) {
      try {
        // Dependencies may be symlinked outside the repository; resolve them whenever they are visible.
        return fs.realpathSync(file);
      } catch { }
    }
    return file;
  };
  getDirectories = (dir: string): string[] => {
    dir = this.realpath(dir);
    if (!this.directoryExists(dir)) return [];
    const children = new Set<string>();
    for (const child of this.directories) {
      if (path.dirname(child) === dir && child !== dir) children.add(path.basename(child));
    }
    for (const entry of this.diskEntries(dir)) {
      if (entry.isDirectory()) children.add(entry.name);
    }
    return [...children];
  };

  readDirectory = (
    dir: string,
    extensions?: readonly string[],
    excludes?: readonly string[],
    includes?: readonly string[],
    depth?: number,
  ): string[] => {
    const patterns = (values: readonly string[]) => values.flatMap(value => {
      const absolute = path.resolve(dir, value);
      if (path.extname(absolute)) return [absolute];
      return [absolute, path.join(absolute, '**/*')];
    });
    const excluded = patterns(excludes ?? []);
    const included = patterns(includes ?? ['**/*']);
    const matches = (file: string, patterns: readonly string[]) => {
      return patterns.some(pattern => path.matchesGlob(file, pattern));
    };
    if (!this.directoryExists(dir)) return [];
    const files = new Set(this.entries.keys());
    for (const entry of this.diskEntries(dir)) {
      if (entry.isFile()) files.add(path.join(dir, entry.name));
    }
    return [...files].filter(file => {
      const relative = path.relative(dir, file);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
      if (depth != null && relative.split(path.sep).length > depth) return false;
      if (extensions && !extensions.some(ext => file.endsWith(ext))) return false;
      return !matches(file, excluded) && matches(file, included);
    });
  };
}

/** Snapshot keys always use the platform separator, while hosts may pass either one. */
function normalize(file: string): string {
  return path.sep === '\\' ? file.replace(/\//g, '\\') : file.replace(/\\/g, '/');
}
