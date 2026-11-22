import { describe, expect, it } from 'vitest';
import { App, Workflow } from '../src/index.js';

describe('overrides', () => {
  it('workflow addOverride with array index paths and deletion', () => {
    const app = new App();
    const wf = new Workflow(app, 'ci', { on: 'push' });
    const j = wf.addJob('build', { runsOn: 'ubuntu-latest' });
    j.addStep({ run: 'a' });
    j.addStep({ run: 'b' });
    wf.addOverride('jobs.build.steps.0.run', 'changed');
    wf.addOverride('jobs.build.runs-on', 'macos-latest');
    wf.addOverride('x.y.z', 1);
    wf.addDeletionOverride('jobs.build.steps.1');
    const o = wf.toObject() as any;
    expect(o.jobs.build.steps).toEqual([{ run: 'changed' }]);
    expect(o.jobs.build['runs-on']).toBe('macos-latest');
    expect(o.x).toEqual({ y: { z: 1 } });
  });

  it('job addOverride / addDeletionOverride', () => {
    const app = new App();
    const wf = new Workflow(app, 'ci', { on: 'push' });
    const j = wf.addJob('build', { runsOn: 'ubuntu-latest', timeoutMinutes: 5 });
    j.addStep({ run: 'a', name: 'A' });
    j.addOverride('steps.0.env.FOO', 'bar');
    j.addDeletionOverride('timeout-minutes');
    const o = wf.toObject() as any;
    expect(o.jobs.build.steps[0].env).toEqual({ FOO: 'bar' });
    expect(o.jobs.build['timeout-minutes']).toBeUndefined();
  });
});
