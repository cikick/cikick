import { emptyLockfile, readLockfile, selectMigrations, type Migration, type MigrationContext } from '@cikick/core';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import semver from 'semver';
import { Project } from 'ts-morph';
import { findConfigFile } from './config.js';
import { discoverPackages, type CikickPackage } from './packages.js';
import { runSynth, type RunOptions, type SynthOutcome } from './run.js';

export interface PlannedMigration {
  pkg: string;
  from: string;
  to: string;
  migration: Migration;
}

export interface UpdateOptions extends RunOptions {
  dryRun?: boolean;
}

export interface UpdateOutcome {
  planned: PlannedMigration[];
  ran: PlannedMigration[];
  /** First-adoption / unchanged packages whose versions get recorded. */
  recorded: Record<string, string>;
  synth?: SynthOutcome;
}

export function planFor(pkg: CikickPackage, from: string, to: string): PlannedMigration[] {
  if (semver.gte(from, to)) return [];
  return selectMigrations(pkg.exports.migrations, from, to).map((migration) => ({ pkg: pkg.name, from, to, migration }));
}

function makeContext(repoDir: string, configPath: string, log: (m: string) => void): MigrationContext {
  const project = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  project.addSourceFileAtPath(configPath);
  return {
    repoDir,
    project,
    log,
    readFile(p) {
      const f = join(repoDir, p);
      return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
    },
    writeFile(p, content) {
      const f = join(repoDir, p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content);
    },
    deleteFile(p) {
      rmSync(join(repoDir, p), { force: true });
    },
  };
}

export async function runMigrations(repoDir: string, planned: PlannedMigration[], log: (m: string) => void = () => {}): Promise<void> {
  if (!planned.length) return;
  const ctx = makeContext(repoDir, findConfigFile(repoDir), log);
  for (const p of planned) {
    log(`migrate ${p.pkg}@${p.migration.version}: ${p.migration.description}`);
    await p.migration.run(ctx);
    ctx.project.saveSync();
    // pick up edits made through writeFile
    for (const sf of ctx.project.getSourceFiles()) sf.refreshFromFileSystemSync();
  }
}

export async function runUpdate(opts: UpdateOptions = {}): Promise<UpdateOutcome> {
  const repoDir = resolve(opts.repoDir ?? process.cwd());
  const log = opts.log ?? (() => {});
  const pkgs = await discoverPackages(repoDir);
  const lock = readLockfile(repoDir) ?? emptyLockfile();
  const planned: PlannedMigration[] = [];
  const recorded: Record<string, string> = {};
  for (const p of pkgs) {
    const from = lock.packages[p.name];
    recorded[p.name] = p.version;
    if (!from) {
      log(`${p.name}@${p.version}: first adoption, recording version (no migrations)`);
      continue;
    }
    if (semver.gt(from, p.version)) log(`${p.name}: installed ${p.version} is older than locked ${from}; skipping migrations`);
    else if (from !== p.version) log(`${p.name}: ${from} -> ${p.version}`);
    planned.push(...planFor(p, from, p.version));
  }
  if (opts.dryRun) {
    for (const m of planned) log(`would run ${m.pkg}@${m.migration.version}: ${m.migration.description}`);
    if (!planned.length) log('no migrations to run');
    return { planned, ran: [], recorded };
  }
  await runMigrations(repoDir, planned, log);
  const synth = await runSynth({ ...opts, repoDir });
  return { planned, ran: planned, recorded, synth };
}

/** Run one package's migrations explicitly (`cikick migrate <pkg> --from <v> [--to <v>]`). */
export async function runMigrate(opts: RunOptions & { pkg: string; from: string; to?: string }): Promise<PlannedMigration[]> {
  const repoDir = resolve(opts.repoDir ?? process.cwd());
  const pkgs = await discoverPackages(repoDir);
  const p = pkgs.find((x) => x.name === opts.pkg);
  if (!p) throw new Error(`${opts.pkg} is not an installed cikick package of ${repoDir}`);
  const planned = planFor(p, opts.from, opts.to ?? p.version);
  await runMigrations(repoDir, planned, opts.log);
  return planned;
}
