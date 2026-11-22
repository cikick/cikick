import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActionResolver } from '@cikick/core';
import { discoverPackages, runCheck, runSynth, runUpdate } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, 'fixtures-tmp');
mkdirSync(base, { recursive: true });
const SHA = 'a'.repeat(40);
const resolver: ActionResolver = { resolve: async () => SHA };

afterAll(() => rmSync(base, { recursive: true, force: true }));

function makeRepo(opts: { pkgVersion?: string; lock?: unknown } = {}) {
  const dir = mkdtempSync(join(base, 'repo-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'r', devDependencies: { 'fake-wf': '*' } }));
  writeFileSync(
    join(dir, 'cikick.config.ts'),
    `import { App, Workflow } from '@cikick/core';
export default (app: App) => {
  const wf = new Workflow(app, 'ci', { on: 'push' });
  wf.addJob('t', { runsOn: 'ubuntu-latest' }).addStep({ uses: 'actions/checkout@v4' });
};
`,
  );
  const pkg = join(dir, 'node_modules', 'fake-wf');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'fake-wf', version: opts.pkgVersion ?? '1.0.0', cikick: './cikick.mjs' }),
  );
  writeFileSync(
    join(pkg, 'cikick.mjs'),
    `const mk = (version) => ({ version, description: 'rename ci to ci-' + version.replace(/\\./g, '_'), async run(ctx) {
  const sf = ctx.project.getSourceFiles()[0];
  sf.replaceWithText(sf.getFullText().replace("'ci'", "'ci-" + version.replace(/\\./g, '_') + "'"));
  ctx.log('did ' + version);
} });
export const migrations = [mk('2.0.0'), mk('1.5.0'), mk('3.0.0')];
export const checks = [{ id: 'fake/always', severity: 'error', run: () => [{ checkId: 'fake/always', severity: 'error', message: 'boom' }] }];
`,
  );
  if (opts.lock) writeFileSync(join(dir, 'cikick.lock.json'), JSON.stringify(opts.lock));
  return dir;
}

const noErrChecks = (dir: string) => {
  // drop the always-failing check for tests that need a clean run
  const f = join(dir, 'node_modules/fake-wf/cikick.mjs');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/export const checks[^\n]*\n/, ''));
};

describe('cli', () => {
  it('discovers cikick packages', async () => {
    const dir = makeRepo();
    const pkgs = await discoverPackages(dir);
    expect(pkgs.map((p) => `${p.name}@${p.version}`)).toEqual(['fake-wf@1.0.0']);
    expect(pkgs[0]!.exports.migrations).toHaveLength(3);
  });

  it('synth writes workflow + lock, records versions, reports package check errors', async () => {
    const dir = makeRepo();
    const r = await runSynth({ repoDir: dir, resolver });
    expect(existsSync(join(dir, '.github/workflows/ci.yml'))).toBe(true);
    expect(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8')).toContain(`actions/checkout@${SHA}`);
    const lock = JSON.parse(readFileSync(join(dir, 'cikick.lock.json'), 'utf8'));
    expect(lock.packages).toEqual({ 'fake-wf': '1.0.0' });
    expect(lock.actions['actions/checkout@v4'].sha).toBe(SHA);
    expect(r.hasErrors).toBe(true);
  });

  it('frozen synth errors on missing lock entries', async () => {
    const dir = makeRepo();
    await expect(runSynth({ repoDir: dir, frozen: true })).rejects.toThrow(/frozen/);
  });

  it('check passes when in sync and detects drift', async () => {
    const dir = makeRepo();
    noErrChecks(dir);
    await runSynth({ repoDir: dir, resolver });
    expect((await runCheck({ repoDir: dir })).ok).toBe(true);
    writeFileSync(join(dir, '.github/workflows/ci.yml'), '# tampered\n');
    const r = await runCheck({ repoDir: dir });
    expect(r.ok).toBe(false);
    expect(r.drift).toContain('.github/workflows/ci.yml');
  });

  it('update runs the right migrations in order and records versions', async () => {
    const dir = makeRepo({ pkgVersion: '2.0.0', lock: { version: 1, actions: {}, packages: { 'fake-wf': '1.0.0' } } });
    noErrChecks(dir);
    const logs: string[] = [];
    const dry = await runUpdate({ repoDir: dir, dryRun: true, log: (m) => logs.push(m) });
    expect(dry.planned.map((p) => p.migration.version)).toEqual(['1.5.0', '2.0.0']);
    expect(readFileSync(join(dir, 'cikick.config.ts'), 'utf8')).toContain("'ci'");

    const r = await runUpdate({ repoDir: dir, resolver });
    expect(r.ran.map((p) => p.migration.version)).toEqual(['1.5.0', '2.0.0']);
    // 3.0.0 not run; 2.0.0 applied on top of 1.5.0 edit (second replace finds no 'ci', first stays)
    expect(readFileSync(join(dir, 'cikick.config.ts'), 'utf8')).toContain("'ci-1_5_0'");
    expect(existsSync(join(dir, '.github/workflows/ci-1_5_0.yml'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'cikick.lock.json'), 'utf8')).packages).toEqual({ 'fake-wf': '2.0.0' });
  });

  it('update on first adoption skips migrations but records version', async () => {
    const dir = makeRepo({ pkgVersion: '3.0.0' });
    noErrChecks(dir);
    const r = await runUpdate({ repoDir: dir, resolver });
    expect(r.ran).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'cikick.lock.json'), 'utf8')).packages).toEqual({ 'fake-wf': '3.0.0' });
  });
});
