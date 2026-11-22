import { secretsManifest } from '@cikick/core';
import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { RENOVATE_SNIPPET, SCRIPTS_HINT, STARTER_CONFIG } from '../init.js';
import { runCheck, runLock, runSynth } from '../run.js';
import { runMigrate, runUpdate } from '../update.js';

const log = (m: string) => console.log(m);

export function buildProgram(): Command {
  const program = new Command('cikick').description('CDK-style workflow manager for GitHub Actions');
  const dir = (c: Command) => c.option('--dir <repo>', 'repository directory', process.cwd());

  dir(program.command('synth').description('synthesize workflows and lockfile'))
    .option('--frozen', 'fail if the lockfile is missing entries')
    .option('--refresh', 're-resolve all action refs')
    .action(async (o) => {
      const r = await runSynth({ repoDir: o.dir, frozen: o.frozen, refresh: o.refresh, log });
      if (r.hasErrors) process.exitCode = 1;
    });

  dir(program.command('check').description('verify generated files are up to date (for CI)')).action(async (o) => {
    const r = await runCheck({ repoDir: o.dir, log });
    if (!r.ok) {
      if (r.drift.length) console.error('Generated files are out of date. Run `npx cikick synth` and commit.');
      process.exitCode = 1;
    }
  });

  dir(program.command('lock').description('resolve and update cikick.lock.json only'))
    .option('--refresh', 're-resolve all action refs')
    .action(async (o) => {
      const r = await runLock({ repoDir: o.dir, refresh: o.refresh, log });
      if (r.hasErrors) process.exitCode = 1;
    });

  dir(program.command('update').description('run package migrations, then synth'))
    .option('--dry-run', 'list migrations without running them')
    .action(async (o) => {
      const r = await runUpdate({ repoDir: o.dir, dryRun: o.dryRun, log });
      if (r.synth?.hasErrors) process.exitCode = 1;
    });

  dir(program.command('migrate <pkg>').description("run a package's migrations explicitly"))
    .requiredOption('--from <version>', 'version migrating from')
    .option('--to <version>', 'version migrating to (default: installed)')
    .action(async (pkg, o) => {
      await runMigrate({ repoDir: o.dir, pkg, from: o.from, to: o.to, log });
    });

  dir(program.command('secrets').description('print the declared secrets manifest'))
    .option('--json', 'machine-readable output')
    .action(async (o) => {
      const { app } = await loadConfig(resolve(o.dir));
      const m = secretsManifest(app);
      if (o.json) return console.log(JSON.stringify(m, null, 2));
      if (!m.length) return console.log('No secrets declared.');
      const rows = [
        ['NAME', 'SCOPE', 'ENVIRONMENT', 'MAX AGE (d)', 'PROVIDER'],
        ...m.map((s) => [s.name, s.scope, s.environment ?? '-', String(s.maxAgeDays ?? '-'), s.provider ?? '-']),
      ];
      const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
      for (const r of rows)
        console.log(
          r
            .map((c, i) => c.padEnd(w[i]!))
            .join('  ')
            .trimEnd(),
        );
    });

  dir(program.command('init').description('write a starter cikick.config.ts')).action((o) => {
    const p = join(resolve(o.dir), 'cikick.config.ts');
    if (existsSync(p)) console.log('cikick.config.ts already exists, leaving it untouched');
    else {
      writeFileSync(p, STARTER_CONFIG);
      console.log('wrote cikick.config.ts');
    }
    console.log('\n' + SCRIPTS_HINT + '\n\nSample renovate.json:\n' + RENOVATE_SNIPPET);
  });

  return program;
}
