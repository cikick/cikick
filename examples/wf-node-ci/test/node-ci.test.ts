import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, GENERATED_HEADER, emptyLockfile, secretsManifest, synth } from '@cikick/core';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { NodeCi } from '../src/index.js';
import { migrations, checks } from '../src/cikick.js';

const lock = () => {
  const l = emptyLockfile();
  for (const k of ['actions/checkout@v7', 'actions/setup-node@v7', 'pnpm/action-setup@v6'])
    l.actions[k] = { sha: 'c'.repeat(40), resolvedAt: '2026-01-01T00:00:00Z' };
  return l;
};
const dir = () => mkdtempSync(join(tmpdir(), 'nci-'));

describe('NodeCi', () => {
  it('synths ci workflow, nvmrc, renovate', async () => {
    const app = new App();
    new NodeCi(app, 'node', { nodeVersion: 24, packageManager: 'pnpm', release: {} });
    const r = await synth(app, { repoDir: dir(), lock: lock(), frozen: true });
    expect(r.files.map((f) => f.path)).toEqual(['.github/workflows/ci.yml', '.nvmrc', 'renovate.json']);
    const ci = r.files[0]!.content;
    expect(ci).toContain(`pnpm/action-setup@${'c'.repeat(40)} # v6`);
    expect(ci).toContain('node-version: 24');
    expect(ci).toContain('${{ secrets.NPM_TOKEN }}');
    expect(r.files[1]!.content).toBe('24\n');
    expect(r.files[2]!.content).not.toContain('pinGitHubActionDigests');
    expect(JSON.parse(r.files[2]!.content)['github-actions']).toEqual({ enabled: false });
    expect(secretsManifest(app)).toEqual([{ name: 'NPM_TOKEN', scope: 'repo', maxAgeDays: 90, provider: 'npm' }]);
  });
  it('defaults: npm, node 22, no release; escape hatches', async () => {
    const app = new App();
    const ci = new NodeCi(app, 'node', { lint: false });
    ci.testJob.addOverride('runs-on', 'self-hosted');
    const r = await synth(app, { repoDir: dir(), lock: lock() });
    expect(r.files[0]!.content).toContain('runs-on: self-hosted');
    expect(r.files[0]!.content).not.toContain('pnpm');
    expect(r.files[0]!.content).not.toContain('Lint');
    expect(ci.releaseJob).toBeUndefined();
    expect(ci.workflow.jobs.map((j) => j.node.id)).toEqual(['build', 'test']);
  });
  it('merges renovate.patch.json', async () => {
    const d = dir();
    writeFileSync(join(d, 'renovate.patch.json'), JSON.stringify({ labels: ['deps'] }));
    const app = new App();
    new NodeCi(app, 'node');
    const r = await synth(app, { repoDir: d, lock: lock() });
    expect(JSON.parse(r.files[2]!.content).labels).toEqual(['deps']);
  });
});

describe('migration 2.0.0', () => {
  const mig = migrations.find((m) => m.version === '2.0.0')!;
  it('renames node -> nodeVersion and deletes generated legacy workflow', async () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      'cikick.config.ts',
      `import { NodeCi } from '@acme/wf-node-ci';
const node = 20;
export default (app) => {
  new NodeCi(app, 'ci', { node: 18, test: 'x' });
  new NodeCi(app, 'ci2', { node });
  new Other(app, 'o', { node: 1 });
};`,
    );
    const d = dir();
    mkdirSync(join(d, '.github/workflows'), { recursive: true });
    writeFileSync(join(d, '.github/workflows/node.yml'), `${GENERATED_HEADER}\non: push\n`);
    const logs: string[] = [];
    await mig.run({
      repoDir: d,
      project,
      log: (m) => logs.push(m),
      writeFile() {},
      deleteFile: (p) => rmSync(join(d, p), { force: true }),
      readFile: (p) => (existsSync(join(d, p)) ? require_fs(join(d, p)) : undefined),
    });
    const out = sf.getFullText();
    expect(out).toContain("{ nodeVersion: 18, test: 'x' }");
    expect(out).toContain('{ nodeVersion: node }');
    expect(out).toContain("new Other(app, 'o', { node: 1 })");
    expect(existsSync(join(d, '.github/workflows/node.yml'))).toBe(false);
  });
  it('keeps hand-written node.yml', async () => {
    const d = dir();
    mkdirSync(join(d, '.github/workflows'), { recursive: true });
    writeFileSync(join(d, '.github/workflows/node.yml'), 'on: push\n');
    await mig.run({
      repoDir: d,
      project: new Project({ useInMemoryFileSystem: true }),
      log() {},
      writeFile() {},
      deleteFile: (p) => rmSync(join(d, p), { force: true }),
      readFile: (p) => require_fs(join(d, p)),
    });
    expect(existsSync(join(d, '.github/workflows/node.yml'))).toBe(true);
  });
});

import { readFileSync, rmSync } from 'node:fs';
const require_fs = (p: string) => readFileSync(p, 'utf8');

describe('checks', () => {
  it('nvmrc nudge escalates after date', async () => {
    const c = checks[0]!;
    const ctx = { app: new App(), repoDir: '.', readFile: (p: string) => (p === '.nvmrc' ? '18\n' : undefined) };
    expect(await c.run(ctx)).toHaveLength(1);
    expect(await c.run({ ...ctx, readFile: () => '22' })).toEqual([]);
    expect(c.enforceAfter).toBeDefined();
  });
});
