import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, emptyLockfile, synth } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ConventionalCommits, NodeCi, ReleasePlease } from '../src/index.js';

const lock = () => {
  const l = emptyLockfile();
  for (const k of [
    'actions/checkout@v7',
    'actions/setup-node@v7',
    'pnpm/action-setup@v6',
    'googleapis/release-please-action@v5',
    'actions/create-github-app-token@v3',
    'amannn/action-semantic-pull-request@v6',
  ])
    l.actions[k] = { sha: 'a'.repeat(40), resolvedAt: '2026-01-01T00:00:00Z' };
  return l;
};
async function run(build: (app: App) => void) {
  const app = new App();
  build(app);
  applyBaseline(app);
  const r = await synth(app, { repoDir: mkdtempSync(join(tmpdir(), 'wf-')), lock: lock() });
  const file = (p: string) => r.files.find((f) => f.path === p);
  return { r, file, yaml: (p: string) => parse(file(p)!.content) };
}
const errors = (r: { findings: { severity: string }[] }) => r.findings.filter((f) => f.severity === 'error');

describe('NodeCi', () => {
  it('pnpm defaults: build, test, cikick check', async () => {
    const { r, yaml } = await run((app) => new NodeCi(app, 'ci'));
    const steps = yaml('.github/workflows/ci.yml').jobs.check.steps;
    expect(steps.map((s: any) => s.name ?? s.uses.split('@')[0])).toEqual([
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'Install',
      'Build',
      'Test',
      'cikick check',
    ]);
    expect(steps.at(-1).run).toBe('npx cikick check');
    expect(errors(r)).toEqual([]);
  });

  it('npm, custom commands, no cikick check', async () => {
    const { yaml } = await run(
      (app) => new NodeCi(app, 'ci', { packageManager: 'npm', commands: { Lint: 'npm run lint' }, cikickCheck: false }),
    );
    const steps = yaml('.github/workflows/ci.yml').jobs.check.steps;
    expect(steps.some((s: any) => s.uses?.startsWith('pnpm/'))).toBe(false);
    expect(steps.slice(-2).map((s: any) => s.run)).toEqual(['npm ci', 'npm run lint']);
  });
});

describe('ReleasePlease', () => {
  it('single package: config, seeded manifest, GITHUB_TOKEN permissions', async () => {
    const { r, file, yaml } = await run((app) => new ReleasePlease(app, 'rp'));
    const cfg = JSON.parse(file('release-please-config.json')!.content);
    expect(cfg.packages).toEqual({ '.': {} });
    expect(cfg.plugins).toBeUndefined();
    const manifest = file('.release-please-manifest.json')!;
    expect(manifest.mode).toBe('seeded');
    expect(JSON.parse(manifest.content)).toEqual({ '.': '0.1.0' });
    const wf = yaml('.github/workflows/release-please.yml');
    expect(wf.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    expect(wf.jobs['release-please'].outputs.releases_created).toContain('steps.release.outputs');
    expect(errors(r)).toEqual([]);
  });

  it('monorepo with app token', async () => {
    const { file, yaml } = await run(
      (app) => new ReleasePlease(app, 'rp', { packages: ['packages/a', 'packages/b'], appToken: {} }),
    );
    const cfg = JSON.parse(file('release-please-config.json')!.content);
    expect(cfg.plugins).toEqual(['node-workspace']);
    expect(Object.keys(cfg.packages)).toEqual(['packages/a', 'packages/b']);
    const wf = yaml('.github/workflows/release-please.yml');
    expect(wf.permissions).toEqual({ contents: 'read' });
    const [tok, rp] = wf.jobs['release-please'].steps;
    expect(tok.with['private-key']).toBe('${{ secrets.RELEASE_APP_PRIVATE_KEY }}');
    expect(rp.with.token).toBe('${{ steps.app-token.outputs.token }}');
  });
});

describe('ConventionalCommits', () => {
  it('lints PR titles on pull_request with read-only permissions', async () => {
    const { r, yaml } = await run((app) => new ConventionalCommits(app, 'cc', { types: ['feat', 'fix'] }));
    const wf = yaml('.github/workflows/pr-title.yml');
    expect(Object.keys(wf.on)).toEqual(['pull_request']);
    expect(wf.on.pull_request.types).toContain('edited');
    expect(wf.permissions).toEqual({ 'pull-requests': 'read' });
    expect(wf.jobs['conventional-title'].steps[0].with.types).toBe('feat\nfix');
    expect(errors(r)).toEqual([]);
  });
});
