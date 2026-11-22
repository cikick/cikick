import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aspects, App, Checks, Workflow, emptyLockfile, synth, type Check } from '@cikick/core';
import { describe, expect, it } from 'vitest';
import {
  DefaultTimeout, ExplicitPermissions, HardenRunner, ReplaceAction, applyBaseline, deprecatedAction, fileContains,
  noPullRequestTargetCheckout, noScriptInjection, requireExplicitPermissions, requirePinnedActions, requireTimeout, securityBaseline,
} from '../src/index.js';

const SHA = (c: string) => c.repeat(40);
const lockFor = (...keys: string[]) => {
  const l = emptyLockfile();
  for (const k of keys) l.actions[k] = { sha: SHA('b'), resolvedAt: '2026-01-01T00:00:00Z' };
  return l;
};
const dir = () => mkdtempSync(join(tmpdir(), 'pol-'));

function mk(on: any = { push: {} }) {
  const app = new App();
  const wf = new Workflow(app, 'ci', { on });
  const job = wf.addJob('build', { runsOn: 'ubuntu-latest' });
  return { app, wf, job };
}
async function run(app: App, checks: Check[], opts: { repoDir?: string; now?: Date; lock?: string[] } = {}) {
  for (const c of checks) Checks.of(app).add(c);
  return synth(app, { repoDir: opts.repoDir ?? dir(), lock: lockFor(...(opts.lock ?? [])), now: opts.now });
}

describe('aspects', () => {
  it('ExplicitPermissions sets workflow permissions only when absent', async () => {
    const a = mk(); a.job.addStep({ run: 'x' });
    const b = mk(); b.wf.props.permissions = { contents: 'write' };
    for (const x of [a, b]) Aspects.of(x.app).add(new ExplicitPermissions({ default: { contents: 'read' } }));
    await synth(a.app, { repoDir: dir() }); await synth(b.app, { repoDir: dir() });
    expect(a.wf.toObject().permissions).toEqual({ contents: 'read' });
    expect(b.wf.toObject().permissions).toEqual({ contents: 'write' });
  });
  it('ExplicitPermissions job level', async () => {
    const { app, job } = mk(); job.addStep({ run: 'x' });
    Aspects.of(app).add(new ExplicitPermissions({ level: 'job' }));
    await synth(app, { repoDir: dir() });
    expect(job.permissions).toEqual({ contents: 'read' });
  });
  it('DefaultTimeout', async () => {
    const { app, wf, job } = mk(); job.addStep({ run: 'x' });
    wf.addJob('other', { runsOn: 'x', timeoutMinutes: 5 });
    Aspects.of(app).add(new DefaultTimeout(15));
    await synth(app, { repoDir: dir() });
    expect(job.props.timeoutMinutes).toBe(15);
    expect(wf.jobs[1]!.props.timeoutMinutes).toBe(5);
  });
  it('HardenRunner prepends once, preserving step order', async () => {
    const { app, job } = mk();
    job.addStep({ name: 'one', run: 'a' }); job.addStep({ name: 'two', uses: 'actions/checkout@v4' });
    Aspects.of(app).add(new HardenRunner({ egressPolicy: 'audit' }));
    const r = await synth(app, { repoDir: dir(), lock: lockFor('actions/checkout@v4', 'step-security/harden-runner@v2') });
    const steps = (job.toObject().steps as any[]);
    expect(steps.map((s) => s.name)).toEqual(['Harden Runner', 'one', 'two']);
    expect(steps[0].with).toEqual({ 'egress-policy': 'audit' });
    expect(r.files[0]!.content).toContain(`step-security/harden-runner@${SHA('b')} # v2`);
    expect(r.lock.actions['step-security/harden-runner@v2']).toBeDefined();
    // second synth does not double up
    await synth(app, { repoDir: dir(), lock: r.lock });
    expect(job.steps).toHaveLength(3);
  });
  it('ReplaceAction swaps refs', async () => {
    const { app, job } = mk(); job.addStep({ uses: 'actions/checkout@v3' }); job.addStep({ uses: 'actions/setup-node@v3' });
    Aspects.of(app).add(new ReplaceAction({ from: 'actions/checkout@v3', to: 'actions/checkout@v4' }));
    await synth(app, { repoDir: dir(), lock: lockFor('actions/checkout@v4', 'actions/setup-node@v3') });
    expect(job.steps.map((s) => s.actionRef!.toSpec())).toEqual(['actions/checkout@v4', 'actions/setup-node@v3']);
  });
});

describe('checks', () => {
  it('requirePinnedActions passes for resolved, errors for docker without digest', async () => {
    const ok = mk(); ok.job.addStep({ uses: 'actions/checkout@v4' }); ok.job.addStep({ uses: './local' });
    expect((await run(ok.app, [requirePinnedActions], { lock: ['actions/checkout@v4'] })).findings).toEqual([]);
    const bad = mk(); bad.job.addStep({ uses: 'docker://alpine:3' });
    const f = (await run(bad.app, [requirePinnedActions])).findings;
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('error');
  });
  it('requirePinnedActions flags unresolved refs when checked directly', async () => {
    const { app, job } = mk(); job.addStep({ uses: 'actions/checkout@v4' });
    const ctx = { app, repoDir: '.', readFile: () => undefined };
    expect(await requirePinnedActions.run(ctx)).toHaveLength(1);
  });
  it('requireExplicitPermissions', async () => {
    const a = mk(); a.job.addStep({ run: 'x' });
    expect((await run(a.app, [requireExplicitPermissions])).findings).toHaveLength(1);
    const b = mk(); b.wf.props.permissions = 'read-all';
    expect((await run(b.app, [requireExplicitPermissions])).findings).toHaveLength(0);
    const c = mk(); c.job.permissions = { contents: 'read' };
    expect((await run(c.app, [requireExplicitPermissions])).findings).toHaveLength(0);
  });
  it('noPullRequestTargetCheckout', async () => {
    const bad = mk({ pullRequestTarget: {} });
    bad.job.addStep({ uses: 'actions/checkout@v4', with: { ref: '${{ github.event.pull_request.head.sha }}' } });
    const f = (await run(bad.app, [noPullRequestTargetCheckout], { lock: ['actions/checkout@v4'] })).findings;
    expect(f.map((x) => x.severity)).toEqual(['error']);
    const safe = mk({ pullRequestTarget: {} }); safe.job.addStep({ uses: 'actions/checkout@v4' });
    expect((await run(safe.app, [noPullRequestTargetCheckout], { lock: ['actions/checkout@v4'] })).findings).toEqual([]);
    const pr = mk({ pullRequest: {} });
    pr.job.addStep({ uses: 'actions/checkout@v4', with: { ref: '${{ github.event.pull_request.head.sha }}' } });
    expect((await run(pr.app, [noPullRequestTargetCheckout], { lock: ['actions/checkout@v4'] })).findings).toEqual([]);
  });
  it('noScriptInjection', async () => {
    const { app, job } = mk();
    job.addStep({ run: 'echo "${{ github.event.pull_request.title }}"' });
    job.addStep({ run: 'echo ${{ github.head_ref }}' });
    job.addStep({ run: 'echo ${{ github.sha }} ${{ secrets.X }}' });
    job.addStep({ run: 'echo "$T"', env: { T: '${{ github.event.issue.title }}' } });
    const f = (await run(app, [noScriptInjection])).findings;
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.severity === 'warn')).toBe(true);
  });
  it('requireTimeout', async () => {
    const { app, wf, job } = mk(); job.addStep({ run: 'x' });
    wf.addJob('t', { runsOn: 'x', timeoutMinutes: 3 });
    expect((await run(app, [requireTimeout])).findings).toHaveLength(1);
  });
  it('deprecatedAction escalates after date', async () => {
    const mkc = () => { const m = mk(); m.job.addStep({ uses: 'actions/upload-artifact@v3' }); m.job.addStep({ uses: 'actions/download-artifact@v3' }); return m; };
    const check = deprecatedAction({ action: 'actions/upload-artifact', below: 'v4', enforceAfter: '2026-06-01' });
    const lock = ['actions/upload-artifact@v3', 'actions/download-artifact@v3'];
    const before = (await run(mkc().app, [check], { lock, now: new Date('2026-01-01') })).findings;
    expect(before.map((f) => f.severity)).toEqual(['warn']);
    const after = (await run(mkc().app, [check], { lock, now: new Date('2026-07-01') })).findings;
    expect(after.map((f) => f.severity)).toEqual(['error']);
    const v4 = mk(); v4.job.addStep({ uses: 'actions/upload-artifact@v4' });
    expect((await run(v4.app, [check], { lock: ['actions/upload-artifact@v4'] })).findings).toEqual([]);
  });
  it('fileContains', async () => {
    const d = dir();
    writeFileSync(join(d, '.nvmrc'), '18\n');
    const check = fileContains({ path: '.nvmrc', pattern: (c) => parseInt(c.trim(), 10) >= 22, message: 'Use Node >= 22', severity: 'warn', enforceAfter: '2026-01-01' });
    const f = (await run(mk().app, [check], { repoDir: d, now: new Date('2026-02-01') })).findings;
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('error');
    writeFileSync(join(d, '.nvmrc'), '22\n');
    expect((await run(mk().app, [check], { repoDir: d })).findings).toEqual([]);
    expect((await run(mk().app, [check], { repoDir: dir() })).findings).toEqual([]);
    expect((await run(mk().app, [fileContains({ path: 'x', pattern: /y/, message: 'm', required: true })])).findings).toHaveLength(1);
  });
});

describe('baseline', () => {
  it('applyBaseline makes a bare workflow compliant', async () => {
    const { app, job } = mk(); job.addStep({ uses: 'actions/checkout@v4' });
    const b = applyBaseline(app);
    expect(b.checks.length).toBeGreaterThan(0);
    expect(securityBaseline().aspects).toHaveLength(2);
    const r = await synth(app, { repoDir: dir(), lock: lockFor('actions/checkout@v4') });
    expect(r.findings).toEqual([]);
    expect(r.files[0]!.content).toContain('permissions:');
    expect(r.files[0]!.content).toContain('timeout-minutes: 30');
  });
});
