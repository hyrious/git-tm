import type { Server } from 'node:http';

import sade from 'sade';
import { name, description, version } from '../package.json';
import { launchServer } from './main';

sade(`${name} [repo]`)
  .describe(description)
  .version(version)
  .option('--verbose', 'Log more information')
  .action(async (repo, opt = {}) => {
    let server: Server & { readonly _thePort: number; };

    try {
      server = await launchServer({ repo });
    } catch (err) {
      console.error(err + '');
      if (err.stderr) {
        console.error(err.stderr);
      }
      process.exitCode = 1;
      return;
    }

    if (opt.verbose) server.on('request', (req, res) => {
      const t0 = performance.now();
      req.once('end', () => {
        const duration = performance.now() - t0;
        const url = req.url || '/';
        console.log(`${res.statusCode} - ${duration.toFixed(2)}ms - ${req.method} ${url}`);
      });
    });

    console.log(`serving http://localhost:${server._thePort}`);
  })
  .parse(process.argv);
