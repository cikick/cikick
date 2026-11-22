import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Workflow, emptyLockfile, secretsManifest, synth } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  BrainLint,
  CloudflareDeploy,
  NodeCi,
  ReleasePlease,
  resolveRegistryAuth,
  toolchainSteps,
} from '../src/index.js';

const lock = () => {
  const l = emptyLockfile();
  for (const k of [
    'actions/checkout@v7',
    'actions/setup-node@v7',
    'actions/upload-artifact@v7',
    'pnpm/action-setup@v6',
    'googleapis/release-please-action@v5',
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
  return { app, r, file, yaml: (p: string) => parse(file(p)!.content) };
}
const errors = (r: { findings: { severity: string }[] }) => r.findings.filter((f) => f.severity === 'error');
const CI = '.github/workflows/ci.yml';
const DEPLOY = '.github/workflows/deploy.yml';
const GUARD = "github.ref == 'refs/heads/main' && github.event_name == 'push'";

describe('CloudflareDeploy guard with into', () => {
  it('adds a push-on-branch guard to every deploy job', async () => {
    const { r, yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci', { jobs: { test: { commands: { T: 't' } } } });
      new CloudflareDeploy(app, 'deploy', {
        into: ci.workflow,
        gate: { jobs: [ci.jobs.test!] },
        targets: [{ kind: 'worker' }, { kind: 'pages', directory: 'dist' }],
      });
    });
    const wf = yaml(CI);
    expect(wf.jobs['deploy-worker'].if).toBe(GUARD);
    expect(wf.jobs['deploy-pages'].if).toBe(GUARD);
    expect(wf.jobs.test.if).toBeUndefined();
    expect(errors(r)).toEqual([]);
  });

  it('without a gate, custom branch and dispatch', async () => {
    const { yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci', { triggers: { workflowDispatch: true } });
      new CloudflareDeploy(app, 'deploy', {
        into: ci.workflow,
        branch: 'release',
        dispatch: true,
        targets: [{ kind: 'worker' }],
      });
    });
    const wf = yaml(CI);
    expect(wf.on.workflow_dispatch).toEqual({});
    expect(wf.jobs.deploy.if).toBe(
      "github.ref == 'refs/heads/release' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
  });

  it('`if` replaces the guard, `false` removes it; own workflow has none', async () => {
    const { yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci');
      new CloudflareDeploy(app, 'a', {
        into: ci.workflow,
        if: "github.event_name == 'push'",
        targets: [{ kind: 'worker', id: 'one' }],
      });
      new CloudflareDeploy(app, 'b', { into: ci.workflow, if: false, targets: [{ kind: 'worker', id: 'two' }] });
      new CloudflareDeploy(app, 'c', { targets: [{ kind: 'worker' }] });
    });
    expect(yaml(CI).jobs.one.if).toBe("github.event_name == 'push'");
    expect(yaml(CI).jobs.two.if).toBeUndefined();
    expect(yaml(DEPLOY).jobs.deploy.if).toBeUndefined();
  });
});

describe('CloudflareDeploy additions', () => {
  it('gate id and if for a reusable workflow call', async () => {
    const { yaml } = await run((app) => {
      new CloudflareDeploy(app, 'deploy', {
        gate: { workflow: 'ci.yml', id: 'check', if: "github.actor != 'bot'" },
        targets: [{ kind: 'worker' }],
      });
    });
    const wf = yaml(DEPLOY);
    expect(wf.jobs.gate).toBeUndefined();
    expect(wf.jobs.check).toMatchObject({ uses: './.github/workflows/ci.yml', if: "github.actor != 'bot'" });
    expect(wf.jobs.deploy.needs).toBe('check');
  });

  it('into with a workflow gate guards the gate job too', async () => {
    const { yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci');
      new CloudflareDeploy(app, 'deploy', {
        into: ci.workflow,
        gate: { workflow: 'x.yml' },
        targets: [{ kind: 'worker' }],
      });
    });
    expect(yaml(CI).jobs.gate.if).toBe(GUARD);
  });

  it('push + workflow_run triggers with a workflow gate that is skipped for workflow_run', async () => {
    const { r, yaml } = await run((app) => {
      new CloudflareDeploy(app, 'deploy', {
        gate: { workflow: 'ci.yml', id: 'check', skipUnlessWorkflowRunSucceeded: true },
        extraTriggers: { workflowRun: { workflows: ['Data refresh'], types: ['completed'], branches: ['main'] } },
        targets: [{ kind: 'worker' }],
      });
    });
    const wf = yaml(DEPLOY);
    expect(wf.on).toEqual({
      push: { branches: ['main'] },
      workflow_run: { workflows: ['Data refresh'], types: ['completed'], branches: ['main'] },
    });
    expect(wf.jobs.check.if).toBe("github.event_name != 'workflow_run'");
    expect(wf.jobs.deploy.needs).toBe('check');
    expect(wf.jobs.deploy.if).toBe(
      "!cancelled() && !failure() && (github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success')",
    );
    expect(wf.jobs.deploy.steps[0].with.ref).toBe('${{ github.event.workflow_run.head_sha || github.sha }}');
    expect(errors(r)).toEqual([]);
    expect(
      () =>
        new CloudflareDeploy(new App(), 'd', {
          into: new Workflow(new App(), 'w', { name: 'w', on: { push: {} } }),
          gate: { workflow: 'x.yml', skipUnlessWorkflowRunSucceeded: true },
          targets: [{ kind: 'worker' }],
        }),
    ).toThrow(/into/);
  });

  it('registryAuth authenticates the install and adds packages: read', async () => {
    const { app, yaml } = await run((a) => {
      new CloudflareDeploy(a, 'deploy', {
        registryAuth: { scope: '@acme', tokenSecret: 'PKG_TOKEN' },
        targets: [{ kind: 'worker' }],
      });
    });
    const wf = yaml(DEPLOY);
    expect(wf.permissions).toEqual({ contents: 'read', packages: 'read' });
    const steps = wf.jobs.deploy.steps;
    expect(steps.find((s: any) => s.uses?.startsWith('actions/setup-node')).with).toMatchObject({
      'registry-url': 'https://npm.pkg.github.com',
      scope: '@acme',
    });
    expect(steps.find((s: any) => s.name === 'Install').env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.PKG_TOKEN }}' });
    expect(secretsManifest(app).map((s) => s.name)).toContain('PKG_TOKEN');
  });

  it('registryAuth with into puts packages: read on the job', async () => {
    const { yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci');
      new CloudflareDeploy(app, 'deploy', {
        into: ci.workflow,
        registryAuth: { scope: '@acme' },
        targets: [{ kind: 'worker' }],
      });
    });
    expect(yaml(CI).jobs.deploy.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(yaml(CI).jobs.deploy.steps.find((s: any) => s.name === 'Install').env).toEqual({
      NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
  });

  it('prebuild entries accept env and a working directory', async () => {
    const { yaml } = await run((app) => {
      new CloudflareDeploy(app, 'deploy', {
        prebuild: {
          'Build shared': 'pnpm build:shared',
          Generate: { run: 'pnpm gen', env: { CI: '1' }, workingDirectory: 'api' },
        },
        targets: [{ kind: 'worker' }],
      });
    });
    const steps = yaml(DEPLOY).jobs.deploy.steps;
    expect(steps.find((s: any) => s.name === 'Build shared')).toEqual({
      name: 'Build shared',
      run: 'pnpm build:shared',
    });
    expect(steps.find((s: any) => s.name === 'Generate')).toEqual({
      name: 'Generate',
      run: 'pnpm gen',
      env: { CI: '1' },
      'working-directory': 'api',
    });
  });

  it('per-secret scope, and per-target account id', async () => {
    const { app, yaml } = await run((a) => {
      new CloudflareDeploy(a, 'deploy', {
        environment: 'production',
        secrets: {
          apiToken: { secret: 'CF_TOKEN', scope: 'org' },
          accountId: { secret: 'CF_ACCOUNT', scope: 'repo' },
        },
        targets: [
          { kind: 'worker' },
          { kind: 'worker', id: 'other', accountId: { variable: 'OTHER_ACCOUNT' } },
          { kind: 'worker', id: 'none', accountId: false },
          { kind: 'worker', id: 'own', accountId: { secret: 'OWN_ACCOUNT' } },
        ],
      });
    });
    const jobs = yaml(DEPLOY).jobs;
    expect(jobs['deploy-worker'].env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CF_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CF_ACCOUNT }}',
    });
    expect(jobs.other.env.CLOUDFLARE_ACCOUNT_ID).toBe('${{ vars.OTHER_ACCOUNT }}');
    expect(jobs.none.env).toEqual({ CLOUDFLARE_API_TOKEN: '${{ secrets.CF_TOKEN }}' });
    expect(jobs.own.env.CLOUDFLARE_ACCOUNT_ID).toBe('${{ secrets.OWN_ACCOUNT }}');
    expect(secretsManifest(app).map((s) => [s.name, s.scope, s.environment])).toEqual([
      ['CF_ACCOUNT', 'repo', 'production'],
      ['CF_TOKEN', 'org', 'production'],
      ['OWN_ACCOUNT', 'env', 'production'],
    ]);
  });

  it('pages directory is optional', async () => {
    const { yaml } = await run((app) => {
      new CloudflareDeploy(app, 'deploy', { targets: [{ kind: 'pages', project: 'site' }] });
    });
    expect(yaml(DEPLOY).jobs.deploy.steps.at(-1).run).toBe('pnpm exec wrangler pages deploy --project-name site');
  });
});

describe('NodeCi additions', () => {
  it('workflowDispatch trigger, per-job if/permissions, install step name', async () => {
    const { yaml } = await run((app) => {
      new NodeCi(app, 'ci', {
        triggers: { workflowDispatch: true },
        installStepName: 'Install dependencies',
        jobs: {
          test: {
            commands: { T: 't' },
            if: "github.event_name == 'pull_request'",
            permissions: { contents: 'read', checks: 'write' },
          },
          lint: { commands: { L: 'l' } },
        },
      });
    });
    const wf = yaml(CI);
    expect(wf.on).toEqual({ push: { branches: ['main'] }, pull_request: {}, workflow_dispatch: {} });
    expect(wf.jobs.test.if).toBe("github.event_name == 'pull_request'");
    expect(wf.jobs.test.permissions).toEqual({ contents: 'read', checks: 'write' });
    expect(wf.jobs.lint.if).toBeUndefined();
    expect(wf.jobs.lint.permissions).toBeUndefined();
    expect(wf.jobs.lint.steps.some((s: any) => s.name === 'Install dependencies')).toBe(true);
    expect(wf.jobs.lint.steps.some((s: any) => s.name === 'Install')).toBe(false);
  });

  it('workflowDispatch accepts inputs; upload-artifact defaults to v7', async () => {
    const { yaml } = await run((app) => {
      new NodeCi(app, 'ci', {
        triggers: { workflowDispatch: { inputs: { debug: { type: 'boolean', default: false } } } },
        jobs: { t: { commands: { T: 't' }, artifacts: [{ name: 'a', path: 'out' }] } },
      });
    });
    const wf = yaml(CI);
    expect(wf.on.workflow_dispatch.inputs.debug).toMatchObject({ type: 'boolean' });
    expect(wf.jobs.t.steps.at(-1).uses).toMatch(/^actions\/upload-artifact@a{40}$/);
  });
});

describe('ReleasePlease additions', () => {
  it('name and file', async () => {
    const { r, yaml } = await run((app) => new ReleasePlease(app, 'rp', { name: 'release', file: 'release' }));
    expect(yaml('.github/workflows/release.yml').name).toBe('release');
    expect(r.files.some((f) => f.path === '.github/workflows/release-please.yml')).toBe(false);
    expect(yaml('.github/workflows/release.yml').jobs['release-please']).toBeDefined();
  });

  it('keeps workflow_dispatch by default; false removes it and the publish_all input', async () => {
    const def = await run((app) => new ReleasePlease(app, 'rp'));
    expect(def.yaml('.github/workflows/release-please.yml').on.workflow_dispatch).toEqual({});
    const off = await run((app) => new ReleasePlease(app, 'rp', { workflowDispatch: false, publish: {} }));
    const wf = off.yaml('.github/workflows/release-please.yml');
    expect(wf.on).toEqual({ push: { branches: ['main'] } });
    expect(wf.jobs.publish.if).toBe("needs.release-please.outputs.releases_created == 'true'");
    expect(JSON.stringify(wf)).not.toContain('publish_all');
    const on = await run((app) => new ReleasePlease(app, 'rp', { publish: {} }));
    expect(on.yaml('.github/workflows/release-please.yml').jobs.publish.if).toContain('inputs.publish_all');
  });

  it('separatePullRequests and plugins replace the monorepo defaults', async () => {
    const def = await run((app) => new ReleasePlease(app, 'rp', { packages: ['a', 'b'] }));
    const d = JSON.parse(def.file('release-please-config.json')!.content);
    expect(d['separate-pull-requests']).toBe(false);
    expect(d.plugins).toEqual(['node-workspace']);
    const custom = await run(
      (app) =>
        new ReleasePlease(app, 'rp', {
          packages: ['a', 'b'],
          separatePullRequests: true,
          plugins: ['cargo-workspace'],
        }),
    );
    const c = JSON.parse(custom.file('release-please-config.json')!.content);
    expect(c['separate-pull-requests']).toBe(true);
    expect(c.plugins).toEqual(['cargo-workspace']);
    const none = await run((app) => new ReleasePlease(app, 'rp', { packages: ['a', 'b'], plugins: [] }));
    expect(JSON.parse(none.file('release-please-config.json')!.content).plugins).toBeUndefined();
  });

  it('emits separate-pull-requests and plugins for a single package only when set', async () => {
    const plain = await run((app) => new ReleasePlease(app, 'rp'));
    const p = JSON.parse(plain.file('release-please-config.json')!.content);
    expect(p['separate-pull-requests']).toBeUndefined();
    expect(p.plugins).toBeUndefined();
    const set = await run(
      (app) => new ReleasePlease(app, 'rp', { separatePullRequests: false, plugins: ['sentence-case'] }),
    );
    const s = JSON.parse(set.file('release-please-config.json')!.content);
    expect(s['separate-pull-requests']).toBe(false);
    expect(s.plugins).toEqual(['sentence-case']);
    expect(s['include-component-in-tag']).toBeUndefined();
  });

  it('job if', async () => {
    const { yaml } = await run((app) => new ReleasePlease(app, 'rp', { if: "github.repository == 'acme/app'" }));
    expect(yaml('.github/workflows/release-please.yml').jobs['release-please'].if).toBe(
      "github.repository == 'acme/app'",
    );
  });
});

describe('BrainLint fromSource', () => {
  it('appends the local command to an existing job without installing the CLI', async () => {
    const { yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci');
      new BrainLint(app, 'brain', {
        job: ci.job,
        fromSource: 'pnpm brain lint --quiet',
        extraCommands: { Site: 'pnpm site' },
      });
    });
    const steps = yaml(CI).jobs.check.steps;
    expect(steps.some((s: any) => s.name === 'Install brain CLI')).toBe(false);
    expect(steps.at(-2)).toEqual({ name: 'brain lint', run: 'pnpm brain lint --quiet' });
    expect(steps.at(-1)).toEqual({ name: 'Site', run: 'pnpm site' });
    expect(yaml(CI).permissions).toEqual({ contents: 'read' });
  });

  it('standalone sets up the toolchain, then runs the command', async () => {
    const { r, yaml } = await run((app) => new BrainLint(app, 'brain', { fromSource: 'pnpm brain lint' }));
    const steps = yaml('.github/workflows/brain.yml').jobs.lint.steps;
    expect(steps.map((s: any) => s.name ?? s.uses.split('@')[0])).toEqual([
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'Install',
      'brain lint',
    ]);
    expect(steps.at(-1).run).toBe('pnpm brain lint');
    expect(errors(r)).toEqual([]);
  });

  it('rejects mixing with the install options and requires cliVersion otherwise', () => {
    const app = new App();
    expect(() => new BrainLint(app, 'a', { fromSource: 'x', cliVersion: '1.0.0' })).toThrow(/fromSource/);
    expect(() => new BrainLint(app, 'b', { fromSource: 'x', registry: 'github' })).toThrow(/fromSource/);
    expect(() => new BrainLint(app, 'c', {})).toThrow(/cliVersion/);
  });
});

describe('toolchainSteps', () => {
  it('is exported with pnpm defaults', () => {
    expect(toolchainSteps()).toEqual([
      { uses: 'actions/checkout@v7', with: undefined },
      { uses: 'pnpm/action-setup@v6' },
      { uses: 'actions/setup-node@v7', with: { 'node-version': 22, cache: 'pnpm' } },
      { name: 'Install', run: 'pnpm install --frozen-lockfile', env: undefined },
    ]);
  });

  it('npm, options and registry auth in a custom workflow', async () => {
    const { yaml } = await run((app) => {
      const wf = new Workflow(app, 'custom', {
        name: 'custom',
        on: { push: {} },
        permissions: { contents: 'read', packages: 'read' },
      });
      const job = wf.addJob('build', { runsOn: 'ubuntu-latest', timeoutMinutes: 5 });
      for (const s of toolchainSteps({
        packageManager: 'npm',
        nodeVersion: 24,
        fetchDepth: 0,
        installStepName: 'Install deps',
        auth: resolveRegistryAuth(wf, { scope: '@acme' }),
      }))
        job.addStep(s);
    });
    const steps = yaml('.github/workflows/custom.yml').jobs.build.steps;
    expect(steps).toHaveLength(3);
    expect(steps[0].with).toEqual({ 'fetch-depth': 0 });
    expect(steps[1].with).toMatchObject({ 'node-version': 24, cache: 'npm', scope: '@acme' });
    expect(steps[2]).toMatchObject({
      name: 'Install deps',
      run: 'npm ci',
      env: { NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
    });
  });
});
