import type { IconifyIcon } from '@iconify/types';

import javascript from '@iconify-icons/nonicons/javascript-16';
import typescript from '@iconify-icons/file-icons/typescript';
import react from '@iconify-icons/nonicons/react-16';
import vue from '@iconify-icons/file-icons/vue';
import svelte from '@iconify-icons/file-icons/svelte';
import html from '@iconify-icons/nonicons/html-16';
import css from '@iconify-icons/nonicons/css-16';
import json from '@iconify-icons/file-icons/json-1';
import yaml from '@iconify-icons/file-icons/yaml';
import toml from '@iconify-icons/file-icons/toml';
import python from '@iconify-icons/nonicons/python-16';
import rust from '@iconify-icons/nonicons/rust-16';
import go from '@iconify-icons/file-icons/go';
import c from '@iconify-icons/file-icons/c';
import cpp from '@iconify-icons/nonicons/c-plusplus-16';
import java from '@iconify-icons/nonicons/java-16';
import php from '@iconify-icons/nonicons/php-16';
import npm from '@iconify-icons/file-icons/npm';
import pnpm from '@iconify-icons/file-icons/pnpm';
import docker from '@iconify-icons/file-icons/docker';
import image from '@iconify-icons/file-icons/image';
import font from '@iconify-icons/file-icons/font';
import config from '@iconify-icons/file-icons/config';
import editorconfig from '@iconify-icons/file-icons/editorconfig';

import { moonbit, nushell } from './file-icon-data';
import { ic } from './icon';

interface FileIcon {
  readonly icon: IconifyIcon;
  readonly color: string;
}

const icons: Record<string, FileIcon> = {
  javascript: { icon: javascript, color: 'yellow' },
  typescript: { icon: typescript, color: 'blue' },
  react: { icon: react, color: 'blue' },
  vue: { icon: vue, color: 'green' },
  svelte: { icon: svelte, color: 'orange' },
  html: { icon: html, color: 'orange' },
  css: { icon: css, color: 'blue' },
  json: { icon: json, color: 'yellow' },
  yaml: { icon: yaml, color: 'purple' },
  toml: { icon: toml, color: 'gray' },
  python: { icon: python, color: 'blue' },
  rust: { icon: rust, color: 'orange' },
  go: { icon: go, color: 'blue' },
  c: { icon: c, color: 'blue' },
  cpp: { icon: cpp, color: 'blue' },
  java: { icon: java, color: 'orange' },
  php: { icon: php, color: 'purple' },
  npm: { icon: npm, color: 'red' },
  pnpm: { icon: pnpm, color: 'yellow' },
  docker: { icon: docker, color: 'blue' },
  image: { icon: image, color: 'purple' },
  font: { icon: font, color: 'orange' },
  config: { icon: config, color: 'gray' },
  editorconfig: { icon: editorconfig, color: 'gray' },
  moonbit: { icon: moonbit, color: 'gray' },
  nushell: { icon: nushell, color: 'green' },
};

const filenames: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  '.npmrc': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  '.editorconfig': 'editorconfig',
  'dockerfile': 'docker',
  'containerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
};

const extensions: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'react',
  tsx: 'react',
  vue: 'vue',
  svelte: 'svelte',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  java: 'java',
  php: 'php',
  mbt: 'moonbit',
  mbti: 'moonbit',
  nu: 'nushell',
  dockerfile: 'docker',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  svg: 'image',
  bmp: 'image',
  tiff: 'image',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  ttc: 'font',
  otc: 'font',
  ini: 'config',
  conf: 'config',
  cfg: 'config',
  env: 'config',
};

export function renderFileIcon(element: HTMLElement, path: string, folder: boolean, collapsed: boolean): void {
  element.replaceChildren();
  element.style.color = '';
  element.setAttribute('aria-hidden', 'true');
  if (folder) {
    element.className = ic(collapsed ? 'folder' : 'folder-opened');
    return;
  }

  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  let type = '';
  if (Object.hasOwn(filenames, name)) {
    type = filenames[name];
  } else if (name.startsWith('.env.')) {
    type = 'config';
  } else if (name.startsWith('dockerfile.')) {
    type = 'docker';
  } else if (Object.hasOwn(extensions, extension)) {
    type = extensions[extension];
  }
  const entry = icons[type];
  if (!entry) {
    let fallback = 'file';
    if (/^(readme|changelog|license|licence|copying)(\.|$)/.test(name) || /^(md|mdx|markdown)$/.test(extension)) {
      fallback = 'book';
    } else if (/^\.git/.test(name)) {
      fallback = 'source-control';
    } else if (/^(sh|bash|zsh|fish|ps1)$/.test(extension)) {
      fallback = 'terminal';
    } else if (/^(zip|gz|tar|bz2|xz|7z|rar)$/.test(extension)) {
      fallback = 'file-zip';
    }
    element.className = ic(fallback);
    return;
  }

  element.className = 'file-icon';
  element.style.color = 'var(--file-icon-' + entry.color + ')';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const { icon } = entry;
  svg.setAttribute('viewBox', [icon.left ?? 0, icon.top ?? 0, icon.width ?? 16, icon.height ?? 16].join(' '));
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.innerHTML = icon.body;
  element.appendChild(svg);
}
