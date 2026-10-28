import { chmodSync, lstatSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { analyzeMetafile, context } from 'esbuild';
import { seq } from '@wopjs/async-seq';
import { noop } from '@wopjs/cast';

rmSync('dist', { recursive: true, force: true });
const build_watch = process.argv.includes('-w');

const build_browser = await context({
  entryPoints: {
    browser: 'src/browser/main.ts',
    style: 'src/browser/style.css',
  },
  bundle: true,
  format: 'esm',
  outdir: 'dist',
  loader: { '.ttf': 'file' },
  assetNames: '[name]',
  metafile: true,
});

const build_cli = await context({
  entryPoints: ['src/node/cli.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  loader: { '.html': 'text' },
  outfile: 'dist/cli.js',
});

async function _rebuild() {
  let t0 = Date.now();
  let browser = await build_browser.rebuild();
  await build_cli.rebuild();
  let t = Date.now() - t0;

  let cli = readFileSync('dist/cli.js', 'utf8');
  cli = '#!/usr/bin/env node\n' + cli;
  writeFileSync('dist/cli.js', cli);
  chmodSync('dist/cli.js', 0o755);

  let fmt = new Intl.NumberFormat();
  let files = readdirSync('dist');
  let width = files.reduce((width, a) => Math.max(width, a.length), 0);
  files.forEach(f => {
    let size = lstatSync(`dist/${f}`).size;
    console.info(`  ${f.padStart(width)}\t${fmt.format(Math.ceil(size / 1024))} kB`);
  });

  console.info();
  console.info(`Built in ${t > 1000 ? Math.ceil(t / 1000) + 's' : t + 'ms'}`);

  console.log(await analyzeMetafile(browser.metafile, { color: true }));
}

function rebuild(): Promise<void> {
  // esbuild prints errors already.
  return _rebuild().catch(noop);
}

if (build_watch) {
  const queue = seq({ dropHead: true, window: 1 });
  const watcher = watch('src', { recursive: true });
  watcher.on('change', () => queue.schedule(rebuild));
  queue.schedule(rebuild);
} else {
  try {
    await _rebuild();
  } finally {
    await build_browser.dispose();
    await build_cli.dispose();
  }
}
