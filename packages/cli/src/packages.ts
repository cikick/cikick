import type { CikickPackageExports } from '@cikick/core';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { importModule } from './config.js';

export interface CikickPackage {
  name: string;
  /** Installed version. */
  version: string;
  dir: string;
  exports: CikickPackageExports;
}

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function findInstalled(repoDir: string, name: string): string | undefined {
  let dir = resolve(repoDir);
  for (;;) {
    const p = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(p, 'package.json'))) return p;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Dependencies of the repo whose installed package.json has a `cikick` field. */
export async function discoverPackages(repoDir: string): Promise<CikickPackage[]> {
  const pj = join(resolve(repoDir), 'package.json');
  if (!existsSync(pj)) return [];
  const root = readJson(pj);
  const names = new Set<string>([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);
  const out: CikickPackage[] = [];
  for (const name of [...names].sort()) {
    const dir = findInstalled(repoDir, name);
    if (!dir) continue;
    const meta = readJson(join(dir, 'package.json'));
    if (typeof meta.cikick !== 'string') continue;
    const mod = await importModule(join(dir, meta.cikick));
    const exp = (
      mod && typeof mod === 'object' && 'migrations' in mod ? mod : (mod?.default ?? mod)
    ) as CikickPackageExports;
    out.push({ name, version: meta.version, dir, exports: { migrations: exp.migrations ?? [], checks: exp.checks } });
  }
  return out;
}

export function installedVersions(pkgs: CikickPackage[]): Record<string, string> {
  return Object.fromEntries(pkgs.map((p) => [p.name, p.version]));
}
