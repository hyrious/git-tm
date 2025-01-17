import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import flru from 'flru';

import { makeTree, Repository, type IBasicGitInfo } from './repository';

import indexHTML from './index.html';
import { getColors, highlight } from './shiki';
const fileCodiconTTF = new URL('./codicon.ttf', import.meta.url);
const fileStyleCSS = new URL('./style.css', import.meta.url);
const fileBrowserJS = new URL('./browser.js', import.meta.url);

export interface ServerOptions {
  readonly repo?: string;
  readonly port?: number;
  readonly host?: string;
}

export async function launchServer(options?: ServerOptions): Promise<http.Server & { readonly _thePort: number; }> {
  const repo = new Repository(findGitRepo(path.resolve(options?.repo ?? '.')));

  const server = http.createServer(catchAll(handleRequest.bind(null, repo)));

  return new Promise((resolve, reject) => {
    let port = options?.port ?? 7000, host = options?.host;
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

async function handleRequest(repo: Repository, req: http.IncomingMessage, res: http.ServerResponse) {
  let pathname = req.url || '/';
  let idx: number, query: URLSearchParams | undefined;
  if (~(idx = pathname.indexOf('?', 1))) {
    query = new URLSearchParams(pathname.slice(idx + 1));
    pathname = pathname.slice(0, idx);
  }
  if (pathname.includes('%')) try {
    pathname = decodeURIComponent(pathname);
  } catch { }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept, Range');
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method === 'GET') {
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
    } else if (pathname === '/tree') { // /tree?ref=HEAD
      const ref = query?.get('ref') || undefined;
      await sendTree(req, res, repo, ref);
    } else if (pathname === '/show') { // /show?ref=HEAD&path=src/main.ts
      const ref = query?.get('ref') || 'HEAD';
      const path = query?.get('path');
      if (path) {
        await sendBlob(req, res, repo, ref, path);
      } else {
        res.statusCode = 400;
        res.end();
      }
    } else if (pathname === '/code') {
      const ref = query?.get('ref') || 'HEAD';
      const path = query?.get('path');
      if (path) {
        await sendHighlightedCode(req, res, repo, ref, path);
      } else {
        res.statusCode = 400;
        res.end();
      }
    } else if (pathname === '/colors.json') {
      const colors = await getColors();
      send(req, res, JSON.stringify(colors), 'application/json');
    } else {
      res.statusCode = 404;
      res.end();
    }
  } else {
    res.statusCode = 405;
    res.end();
  }
}

async function sendBlob(req: http.IncomingMessage, res: http.ServerResponse, repo: Repository, ref: string, path: string): Promise<void> {
  const buffer = await repo.buffer(ref, path);
  const binary = buffer.subarray(0, 8000).indexOf(0) >= 0;
  send(req, res, buffer, binary ? 'application/octet-stream' : 'text/plain');
}

const MAX_CODE_SIZE = 2 * 1024 * 1024;
const cache = flru<string>(20);
async function sendHighlightedCode(req: http.IncomingMessage, res: http.ServerResponse, repo: Repository, ref: string, path: string): Promise<void> {
  const key = `${ref}:${path}`;
  if (cache.has(key)) {
    return send(req, res, cache.get(key)!, 'text/html');
  }

  const buffer = await repo.buffer(ref, path);
  const binary = buffer.subarray(0, 8000).indexOf(0) >= 0;
  if (binary) {
    res.statusCode = 400;
    res.end('File is binary');
    return;
  }
  if (buffer.byteLength > MAX_CODE_SIZE) {
    res.statusCode = 413;
    res.end('File is too large');
    return;
  }
  const code = buffer.toString('utf8');
  const html = await highlight(code, path);
  cache.set(key, html);
  send(req, res, html, 'text/html');
}

async function sendTree(req: http.IncomingMessage, res: http.ServerResponse, repo: Repository, ref?: string): Promise<void> {
  const raw = await repo.lstree(ref ?? 'HEAD', { recursive: true });
  const tree = makeTree(raw);
  send(req, res, JSON.stringify(tree), 'application/json');
}

async function sendLog(req: http.IncomingMessage, res: http.ServerResponse, repo: Repository, skip?: number): Promise<void> {
  const info: IBasicGitInfo = {
    root: repo.root,
    refs: await repo.getRefs(),
    commits: await repo.log({ shortStats: true, skip }),
    total: await repo.logSize(),
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
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const headers: http.OutgoingHttpHeaders = {
    'content-length': stat.size,
    'content-type': contentType,
    'etag': etag,
    'cache-control': "no-cache",
  };
  res.writeHead(200, headers);
  fs.createReadStream(uri).pipe(res, { end: true });
}

function send(req: http.IncomingMessage, res: http.ServerResponse, content: string | Buffer, contentType: string): void {
  const etag = `W/"${len(content).toString(16)}-${hash(content)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const headers: http.OutgoingHttpHeaders = {
    'content-length': len(content),
    'content-type': contentType,
    'etag': etag,
    'cache-control': "no-cache",
  };
  res.writeHead(200, headers);
  res.end(content);
}

function len(content: string | Buffer) {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
}

function hash(content: string | Buffer) {
  return crypto.createHash('sha1').update(content as string, 'utf8').digest('base64').slice(0, 27);
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
