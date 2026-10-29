import type { IBasicGitInfo } from '../common/git';

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

import { Repository } from './repository';
import { Workspace } from './workspace';
import { FileSource, SymbolAction } from '../common/symbols';
import { makeTree } from '../common/tree';

import indexHTML from '../browser/index.html';
const fileCodiconTTF = new URL('./codicon.ttf', import.meta.url);
const fileStyleCSS = new URL('./style.css', import.meta.url);
const fileBrowserJS = new URL('./browser.js', import.meta.url);

export interface ServerOptions {
  readonly repo?: string;
  readonly port?: number;
  readonly host?: string;
}

export async function launchServer(options?: ServerOptions): Promise<http.Server & { readonly _thePort: number; }> {
  const repo = new Repository(findGitRepo(fs.realpathSync(path.resolve(options?.repo ?? '.'))));

  const workspace = new Workspace(repo.root);
  const server = http.createServer(catchAll(handleRequest.bind(null, repo, workspace)));
  server.on('close', () => workspace.dispose());

  return new Promise((resolve, reject) => {
    let port = options?.port ?? 7000, host = options?.host ?? 'localhost';
    const onError = (e: Error & { code?: string; }) => {
      if (e.code === 'EADDRINUSE') {
        server.listen(++port, host);
      } else {
        server.removeListener('error', onError);
        reject();
      }
    };
    server.on('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(Object.assign(server, { _thePort: port }));
    });
  });
}

function catchAll(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>): http.RequestListener {
  return (req, res) => handler(req, res).catch(e => {
    res.writeHead(500);
    res.end(e ? e.message : 'Unknown error');
  });
}

async function handleRequest(repo: Repository, workspace: Workspace, req: http.IncomingMessage, res: http.ServerResponse) {
  let pathname = req.url || '/';
  let idx: number, query: URLSearchParams | undefined;
  if (~(idx = pathname.indexOf('?', 1))) {
    query = new URLSearchParams(pathname.slice(idx + 1));
    pathname = pathname.slice(0, idx);
  }
  if (pathname.includes('%')) try {
    pathname = decodeURIComponent(pathname);
  } catch { }
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method === 'GET') {
    const source = Number(query?.get('source') ?? FileSource.Snapshot);
    if ((pathname === '/show' || pathname === '/symbols') && source !== FileSource.Snapshot && source !== FileSource.External) {
      res.writeHead(400);
      res.end('Invalid file source');
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      send(req, res, indexHTML, 'text/html');
    } else if (pathname === '/browser.js') {
      sendFile(req, res, fileBrowserJS, 'application/javascript');
    } else if (pathname === '/style.css') {
      sendFile(req, res, fileStyleCSS, 'text/css');
    } else if (pathname === '/codicon.ttf') {
      sendFile(req, res, fileCodiconTTF, 'font/ttf');
    } else if (pathname === '/log') { // /log?skip=42
      const skip = Number.parseInt(query?.get('skip') ?? '0', 10) || undefined;
      await sendLog(req, res, repo, skip);
    } else if (pathname === '/revision') {
      send(req, res, JSON.stringify(await repo.resolveRevision(query?.get('ref') ?? '')), 'application/json');
    } else if (pathname === '/tree') { // /tree?ref=HEAD
      const ref = query?.get('workingTree') === '1' ? undefined : query?.get('ref') || 'HEAD';
      await sendTree(req, res, repo, ref);
    } else if (pathname === '/diff') {
      const ref = query?.get('workingTree') === '1' ? undefined : query?.get('ref') || 'HEAD';
      send(req, res, JSON.stringify(await repo.diff(ref)), 'application/json');
    } else if (pathname === '/show') { // /show?ref=HEAD&path=src/main.ts
      const ref = query?.get('workingTree') === '1' ? undefined : query?.get('ref') || 'HEAD';
      const path = query?.get('path');
      if (path) {
        const file = await workspace.file(ref, { source, path });
        const buffer = Buffer.from(file.bytes);
        res.setHeader('X-File-Version', file.version);
        send(req, res, buffer, buffer.subarray(0, 8000).includes(0) ? 'application/octet-stream' : 'text/plain', `"${file.version}"`);
      } else {
        res.statusCode = 400;
        res.end();
      }
    } else if (pathname === '/symbols') {
      const action = Number(query?.get('action'));
      if (!query?.get('action') || !Number.isInteger(action) || action < SymbolAction.FileSymbols || action > SymbolAction.Index) {
        res.writeHead(400);
        res.end('Invalid symbol action');
        return;
      }
      const ref = query?.get('workingTree') === '1' ? undefined : query?.get('ref') || 'HEAD';
      const file = query?.get('path');
      const result = await workspace.symbols(ref, {
        action,
        file: file ? { source, path: file } : undefined,
        version: query?.get('version') ?? undefined,
        position: Number(query?.get('position') ?? 0),
      });
      send(req, res, JSON.stringify(result), 'application/json');
    } else {
      res.statusCode = 404;
      res.end();
    }
  } else {
    res.statusCode = 405;
    res.end();
  }
}

async function sendTree(req: http.IncomingMessage, res: http.ServerResponse, repo: Repository, ref?: string): Promise<void> {
  const raw = ref ? await repo.lstree(ref, { recursive: true }) : await repo.workingTree();
  const tree = makeTree(raw);
  send(req, res, JSON.stringify(tree), 'application/json');
}

async function sendLog(req: http.IncomingMessage, res: http.ServerResponse, repo: Repository, skip?: number): Promise<void> {
  const { head, workingTree } = await repo.getState();
  const info: IBasicGitInfo = {
    head, workingTree,
    root: repo.root,
    refs: await repo.getRefs(),
    commits: await repo.log({ shortStats: true, skip, head: head.commit }),
    total: await repo.logSize(head.commit),
  };
  send(req, res, JSON.stringify(info), 'application/json');
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, uri: URL, contentType: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(uri);
  } catch (e) {
    res.writeHead(404);
    res.end();
    return;
  }
  const etag = `W/"${stat.size.toString(16)}-${stat.mtime.getTime()}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const headers: http.OutgoingHttpHeaders = {
    'content-length': stat.size,
    'content-type': contentType,
    'cache-control': "no-cache",
  };
  res.writeHead(200, headers);
  fs.createReadStream(uri).pipe(res, { end: true });
}

function send(req: http.IncomingMessage, res: http.ServerResponse, content: string | Buffer, contentType: string, etag?: string): void {
  res.setHeader('Cache-Control', 'no-cache');
  if (etag) res.setHeader('ETag', etag);
  if (etag && req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const headers: http.OutgoingHttpHeaders = {
    'content-length': len(content),
    'content-type': contentType,
    'cache-control': "no-cache",
  };
  res.writeHead(200, headers);
  res.end(content);
}

function len(content: string | Buffer) {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
}

function findGitRepo(p: string): string {
  while (true) {
    const a = path.join(p, '.git');
    if (fs.existsSync(a)) {
      return p;
    }
    const b = path.dirname(p);
    if (b === p) {
      throw new Error('Could not find git repository.');
    }
    p = b;
  }
}
