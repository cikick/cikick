import semver from 'semver';
import type { Project } from 'ts-morph';
import type { Check } from './checks.js';

export interface MigrationContext {
  repoDir: string;
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void;
  /** Delete a repo file (no-op if absent). */
  deleteFile(path: string): void;
  /** ts-morph project for the cikick config file. */
  project: Project;
  log(msg: string): void;
}

export interface Migration {
  /** semver of the package that introduced this migration */
  version: string;
  description: string;
  run(ctx: MigrationContext): Promise<void>;
}

/** Shape of what a package exports from the file named by package.json `cikick` field. */
export interface CikickPackageExports {
  migrations: Migration[];
  checks?: Check[];
}

/** Migrations with `from < version <= to`, ordered ascending (stable for equal versions). */
export function selectMigrations<M extends Pick<Migration, 'version'>>(
  migrations: readonly M[],
  from: string,
  to: string,
): M[] {
  for (const v of [from, to]) if (!semver.valid(v)) throw new Error(`Invalid semver "${v}"`);
  return migrations
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => {
      if (!semver.valid(m.version)) throw new Error(`Migration has invalid semver "${m.version}"`);
      return semver.gt(m.version, from) && semver.lte(m.version, to);
    })
    .sort((a, b) => semver.compare(a.m.version, b.m.version) || a.i - b.i)
    .map(({ m }) => m);
}
