import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCKFILE_NAME = 'cikick.lock.json';

export interface LockedAction {
  sha: string;
  resolvedAt: string;
}

export interface Lockfile {
  version: 1;
  /** keyed by `owner/repo@ref` */
  actions: Record<string, LockedAction>;
  /** cikick package versions at last synth */
  packages: Record<string, string>;
}

export function emptyLockfile(): Lockfile {
  return { version: 1, actions: {}, packages: {} };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

/** Stable, sorted-key JSON with trailing newline. */
export function serializeLockfile(lock: Lockfile): string {
  return JSON.stringify(sortKeys(lock), null, 2) + '\n';
}

export function readLockfile(repoDir: string): Lockfile | undefined {
  const p = join(repoDir, LOCKFILE_NAME);
  if (!existsSync(p)) return undefined;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Lockfile>;
  return { version: 1, actions: raw.actions ?? {}, packages: raw.packages ?? {} };
}

export function writeLockfile(repoDir: string, lock: Lockfile): void {
  writeFileSync(join(repoDir, LOCKFILE_NAME), serializeLockfile(lock));
}
