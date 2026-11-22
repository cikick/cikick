import { describe, expect, it } from 'vitest';
import { App, Aspects, Checks, Job, Workflow, synth, type Check, type IAspect } from '../src/index.js';
import { FakeResolver, tmp } from './helpers.js';

describe('aspects', () => {
  it('mutate before render, top-down, applying to descendants', async () => {
    const app = new App();
    const wf = new Workflow(app, 'ci', { on: 'push' });
    wf.addJob('a', {});
    wf.addJob('b', { timeoutMinutes: 1 });
    const order: string[] = [];
    const aspect: IAspect = {
      visit(node) {
        order.push(node.node.id);
        if (Job.isJob(node) && node.props.timeoutMinutes === undefined) node.props.timeoutMinutes = 30;
      },
    };
    Aspects.of(app).add(aspect);
    const res = await synth(app, { repoDir: tmp(), resolver: new FakeResolver() });
    expect(res.files[0]!.content).toContain('timeout-minutes: 30');
    expect(order.indexOf('ci')).toBeLessThan(order.indexOf('a'));
    expect(order[0]).toBe('');
    expect(order.filter((x) => x === 'a')).toHaveLength(1);
  });
});

describe('checks', () => {
  const mk = (c: Partial<Check>): Check => ({ id: 'c1', severity: 'warn', run: () => [{ checkId: 'c1', severity: c.severity ?? 'warn', message: 'm' }], ...c });

  it('reports severity as declared', async () => {
    const app = new App();
    Checks.of(app).add(mk({ severity: 'info' }));
    const res = await synth(app, { repoDir: tmp() });
    expect(res.findings.map((f) => f.severity)).toEqual(['info']);
  });

  it('enforceAfter upgrades warn to error only after date', async () => {
    const app = new App();
    Checks.of(app).add(mk({ enforceAfter: '2026-06-01' }));
    const before = await synth(app, { repoDir: tmp(), now: new Date('2026-05-31T00:00:00Z') });
    const after = await synth(app, { repoDir: tmp(), now: new Date('2026-06-02T00:00:00Z') });
    expect(before.findings[0]!.severity).toBe('warn');
    expect(after.findings[0]!.severity).toBe('error');
  });

  it('checks registered on child scopes run, and ctx gives files + readFile', async () => {
    const app = new App();
    const wf = new Workflow(app, 'ci', { on: 'push' });
    let seen: any;
    Checks.of(wf).add({
      id: 'ctx',
      severity: 'info',
      async run(ctx) {
        seen = { files: ctx.files?.map((f) => f.path), missing: ctx.readFile('nope.txt') };
        return [];
      },
    });
    await synth(app, { repoDir: tmp() });
    expect(seen).toEqual({ files: ['.github/workflows/ci.yml'], missing: undefined });
  });
});
