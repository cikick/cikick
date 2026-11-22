import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, emptyLockfile, secretsManifest, synth } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BrainLint, CloudflareDeploy, NodeCi, ReleasePlease } from '../src/index.js';

const lock = () => {
  const l = emptyLockfile();
  for (const k of [
    'actions/checkout@v7',
    'actions/setup-node@v7',
    'actions/upload-artifact@v4',
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
const warnings = (r: { findings: { severity: string }[] }) => r.findings.filter((f) => f.severity === 'warn');
const CI = '.github/workflows/ci.yml';
const DEPLOY = '.github/workflows/deploy.yml';

describe('NodeCi extensions', () => {
  it('keeps the original output with no new props', async () => {
    const { yaml } = await run((app) => new NodeCi(app, 'ci'));
    const wf = yaml(CI);
    expect(wf.name).toBe('CI');
    expect(wf.on).toEqual({ push: { branches: ['main'] }, pull_request: {} });
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.concurrency).toEqual({ group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true });
    expect(Object.keys(wf.jobs)).toEqual(['check']);
    expect(wf.jobs.check.env).toBeUndefined();
    expect(wf.jobs.check.steps[0]).toEqual({ uses: expect.stringMatching(/^actions\/checkout@a{40}/) });
  });

  it('name, triggers, working directory, env, fetch depth, extra permissions', async () => {
    const { r, yaml } = await run(
      (app) =>
        new NodeCi(app, 'ci', {
          name: 'ci',
          triggers: { push: false, workflowCall: true },
          workingDirectory: 'backend',
          env: { WORKER_URL: '${{ vars.WORKER_URL }}' },
          fetchDepth: 0,
          extraPermissions: { checks: 'write' },
          commands: { Test: 'pnpm test' },
          cikickCheck: false,
        }),
    );
    const wf = yaml(CI);
    expect(wf.name).toBe('ci');
    expect(wf.on).toEqual({ pull_request: {}, workflow_call: {} });
    expect(wf.permissions).toEqual({ contents: 'read', checks: 'write' });
    const job = wf.jobs.check;
    expect(job.env).toEqual({ WORKER_URL: '${{ vars.WORKER_URL }}' });
    expect(job.steps[0].with).toEqual({ 'fetch-depth': 0 });
    expect(job.steps.find((s: any) => s.name === 'Install')['working-directory']).toBeUndefined();
    expect(job.steps.find((s: any) => s.name === 'Test')['working-directory']).toBe('backend');
    expect(errors(r)).toEqual([]);
  });

  it('push trigger object and pull request restrictions', async () => {
    const { yaml } = await run(
      (app) =>
        new NodeCi(app, 'ci', {
          triggers: { push: { branches: ['main', 'next'] }, pullRequest: { branches: ['main'] } },
        }),
    );
    expect(yaml(CI).on).toEqual({ push: { branches: ['main', 'next'] }, pull_request: { branches: ['main'] } });
  });

  it('rejects having no trigger', () => {
    expect(() => new NodeCi(new App(), 'ci', { triggers: { push: false, pullRequest: false } })).toThrow(/trigger/);
  });

  it('cancelInProgress variants', async () => {
    const cancel = async (v: boolean | 'pull-request-only' | undefined) =>
      (await run((app) => new NodeCi(app, 'ci', { cancelInProgress: v }))).yaml(CI).concurrency['cancel-in-progress'];
    expect(await cancel(undefined)).toBe(true);
    expect(await cancel(false)).toBe(false);
    expect(await cancel('pull-request-only')).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('registryAuth passes the token through env, with packages: read', async () => {
    const { r, yaml } = await run(
      (app) => new NodeCi(app, 'ci', { registryAuth: { scope: '@craftvalueorg' }, commands: { Test: 'pnpm test' } }),
    );
    const wf = yaml(CI);
    expect(wf.permissions).toEqual({ contents: 'read', packages: 'read' });
    const steps = wf.jobs.check.steps;
    expect(steps.find((s: any) => s.uses?.startsWith('actions/setup-node')).with).toEqual({
      'node-version': 22,
      cache: 'pnpm',
      'registry-url': 'https://npm.pkg.github.com',
      scope: '@craftvalueorg',
    });
    expect(steps.find((s: any) => s.name === 'Install').env).toEqual({
      NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(JSON.stringify(steps)).not.toContain('echo');
    expect(errors(r)).toEqual([]);
  });

  it('registryAuth with a custom token secret is declared', async () => {
    const { app, yaml } = await run(
      (app) => new NodeCi(app, 'ci', { registryAuth: { scope: '@acme', tokenSecret: 'PKG_TOKEN' } }),
    );
    expect(yaml(CI).jobs.check.steps.find((s: any) => s.name === 'Install').env.NODE_AUTH_TOKEN).toBe(
      '${{ secrets.PKG_TOKEN }}',
    );
    expect(secretsManifest(app).map((s) => s.name)).toEqual(['PKG_TOKEN']);
    expect(() => new NodeCi(new App(), 'x', { registryAuth: { scope: 'acme' } })).toThrow(/scope/);
  });

  it('multiple parallel jobs with per-job directory, env and artifacts', async () => {
    const { r, yaml } = await run(
      (app) =>
        new NodeCi(app, 'ci', {
          env: { CI_FLAG: '1' },
          jobs: {
            backend: { workingDirectory: 'backend', commands: { Typecheck: 'pnpm typecheck' } },
            frontend: {
              name: 'Frontend',
              workingDirectory: 'frontend',
              env: { VITE_API_URL: 'https://api' },
              commands: { Build: 'pnpm build' },
              artifacts: [{ name: 'frontend-dist', path: 'frontend/dist' }],
            },
          },
          cikickCheck: true,
        }),
    );
    const wf = yaml(CI);
    expect(Object.keys(wf.jobs)).toEqual(['backend', 'frontend']);
    expect(wf.jobs.backend.env).toEqual({ CI_FLAG: '1' });
    expect(wf.jobs.frontend.env).toEqual({ CI_FLAG: '1', VITE_API_URL: 'https://api' });
    expect(wf.jobs.frontend.name).toBe('Frontend');
    const names = (j: any) => j.steps.map((s: any) => s.name ?? s.uses.split('@')[0]);
    expect(names(wf.jobs.backend).slice(-2)).toEqual(['Typecheck', 'cikick check']);
    expect(names(wf.jobs.frontend).slice(-2)).toEqual(['Build', 'actions/upload-artifact']);
    expect(wf.jobs.frontend.steps.at(-1).with).toEqual({ name: 'frontend-dist', path: 'frontend/dist' });
    expect(wf.jobs.backend.steps.at(-1)['working-directory']).toBe('backend');
    expect(errors(r)).toEqual([]);
  });

  it('jobs default to no cikick check and cannot mix with commands', async () => {
    const { yaml } = await run((app) => new NodeCi(app, 'ci', { jobs: { a: { commands: { T: 'pnpm test' } } } }));
    expect(JSON.stringify(yaml(CI))).not.toContain('cikick check');
    expect(() => new NodeCi(new App(), 'x', { jobs: {}, commands: {} })).toThrow(/jobs/);
  });

  it('synth is deterministic', async () => {
    const mk = () =>
      run(
        (app) =>
          new NodeCi(app, 'ci', {
            jobs: { b: { commands: { X: 'x' } }, a: { commands: { Y: 'y' } } },
            registryAuth: { scope: '@a' },
          }),
      ).then((x) => x.file(CI)!.content);
    expect(await mk()).toBe(await mk());
  });
});

describe('CloudflareDeploy', () => {
  it('worker with D1 migrations: environment, non-cancelling concurrency, secrets', async () => {
    const { app, r, yaml } = await run(
      (app) =>
        new CloudflareDeploy(app, 'deploy', {
          environment: 'production',
          dispatch: true,
          targets: [
            {
              kind: 'worker',
              workingDirectory: 'backend',
              d1Migrations: { database: 'autobot-db', configPath: 'wrangler.jsonc' },
            },
          ],
        }),
    );
    const wf = yaml(DEPLOY);
    expect(wf.name).toBe('deploy');
    expect(wf.on).toEqual({ push: { branches: ['main'] }, workflow_dispatch: {} });
    expect(wf.concurrency).toEqual({ group: 'deploy-production', 'cancel-in-progress': false });
    expect(wf.permissions).toEqual({ contents: 'read' });
    const job = wf.jobs.deploy;
    expect(job.environment).toBe('production');
    expect(job.env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
    });
    const steps = job.steps.slice(-2);
    expect(steps.map((s: any) => s.run)).toEqual([
      'pnpm exec wrangler d1 migrations apply autobot-db --remote --config wrangler.jsonc',
      'pnpm exec wrangler deploy',
    ]);
    expect(steps.every((s: any) => s['working-directory'] === 'backend')).toBe(true);
    expect(secretsManifest(app).map((s) => [s.name, s.scope, s.environment, s.provider])).toEqual([
      ['CLOUDFLARE_API_TOKEN', 'env', 'production', 'cloudflare'],
    ]);
    expect(errors(r)).toEqual([]);
    expect(warnings(r)).toEqual([]);
  });

  it('account id as a secret, none, custom token and run command', async () => {
    const out = async (accountId: any) =>
      (
        await run(
          (app) =>
            new CloudflareDeploy(app, 'deploy', {
              secrets: { apiToken: 'CF_TOKEN', accountId },
              targets: [{ kind: 'worker', run: 'pnpm --filter @x/api run deploy' }],
            }),
        )
      ).yaml(DEPLOY).jobs.deploy;
    expect((await out({ secret: 'CLOUDFLARE_ACCOUNT_ID' })).env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CF_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
    });
    const none = await out(false);
    expect(none.env).toEqual({ CLOUDFLARE_API_TOKEN: '${{ secrets.CF_TOKEN }}' });
    expect(none.steps.at(-1).run).toBe('pnpm --filter @x/api run deploy');
  });

  it('worker then pages, pages depends on the previous target; prebuild and preSteps', async () => {
    const { yaml } = await run(
      (app) =>
        new CloudflareDeploy(app, 'deploy', {
          prebuild: { 'Build shared': 'pnpm build --filter=@x/shared' },
          preSteps: [{ name: 'Fetch data', run: 'echo fetch' }],
          targets: [
            { kind: 'worker', filter: '@x/api' },
            {
              kind: 'pages',
              directory: 'dist',
              project: 'autobot-app',
              build: 'pnpm build',
              dependsOnPreviousTarget: true,
              env: { VITE_API_URL: 'https://api' },
            },
          ],
        }),
    );
    const wf = yaml(DEPLOY);
    expect(Object.keys(wf.jobs)).toEqual(['deploy-worker', 'deploy-pages']);
    expect(wf.jobs['deploy-pages'].needs).toBe('deploy-worker');
    expect(wf.jobs['deploy-pages'].env.VITE_API_URL).toBe('https://api');
    const names = (j: any) => j.steps.map((s: any) => s.name ?? s.uses.split('@')[0]);
    expect(names(wf.jobs['deploy-worker'])).toEqual([
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node',
      'Install',
      'Fetch data',
      'Build shared',
      'Deploy worker',
    ]);
    expect(wf.jobs['deploy-worker'].steps.at(-1).run).toBe('pnpm --filter @x/api exec wrangler deploy');
    expect(names(wf.jobs['deploy-pages']).slice(-2)).toEqual(['Build', 'Deploy pages']);
    expect(wf.jobs['deploy-pages'].steps.at(-1).run).toBe(
      'pnpm exec wrangler pages deploy dist --project-name autobot-app',
    );
  });

  it('gate on another workflow with workflow_run deploys only the tested push commit', async () => {
    const { r, yaml } = await run(
      (app) => new CloudflareDeploy(app, 'deploy', { gate: { workflowRun: 'CI' }, targets: [{ kind: 'worker' }] }),
    );
    const wf = yaml(DEPLOY);
    expect(wf.on).toEqual({ workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] } });
    const job = wf.jobs.deploy;
    expect(job.if).toBe(
      "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'",
    );
    expect(job.steps[0].with).toEqual({ ref: '${{ github.event.workflow_run.head_sha }}' });
    expect(errors(r)).toEqual([]);
    expect(
      () =>
        new CloudflareDeploy(new App(), 'd', {
          gate: { workflowRun: 'CI' },
          paths: ['a'],
          targets: [{ kind: 'worker' }],
        }),
    ).toThrow(/paths/);
  });

  it('gate on a reusable workflow call', async () => {
    const { yaml } = await run(
      (app) =>
        new CloudflareDeploy(app, 'deploy', {
          gate: { workflow: 'ci.yml', secrets: 'inherit' },
          paths: ['apps/**'],
          targets: [{ kind: 'worker' }],
        }),
    );
    const wf = yaml(DEPLOY);
    expect(wf.on.push).toEqual({ branches: ['main'], paths: ['apps/**'] });
    expect(wf.jobs.gate).toEqual({
      uses: './.github/workflows/ci.yml',
      permissions: { contents: 'read' },
      secrets: 'inherit',
    });
    expect(wf.jobs.deploy.needs).toBe('gate');
  });

  it('deploys inside the CI workflow, gated on its jobs, with per-job concurrency', async () => {
    const { r, yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci', {
        cancelInProgress: 'pull-request-only',
        jobs: { test: { commands: { T: 't' } } },
      });
      new CloudflareDeploy(app, 'deploy', {
        into: ci.workflow,
        gate: { jobs: [ci.jobs.test!] },
        targets: [{ kind: 'worker' }, { kind: 'pages', directory: 'dist' }],
      });
    });
    const wf = yaml(CI);
    expect(wf.jobs['deploy-worker'].needs).toBe('test');
    expect(wf.jobs['deploy-worker'].concurrency).toEqual({
      group: 'deploy-production-deploy-worker',
      'cancel-in-progress': false,
    });
    expect(wf.jobs['deploy-pages'].permissions).toEqual({ contents: 'read' });
    // Workflow-level cancel is limited to pull requests, so the deploy check stays quiet.
    expect(errors(r)).toEqual([]);
    expect(r.files.some((f) => f.path === DEPLOY)).toBe(false);
    const other = new App();
    expect(
      () => new CloudflareDeploy(other, 'd', { gate: { jobs: [ci_job()] }, targets: [{ kind: 'worker' }] }),
    ).toThrow(/into/);
  });

  it('skipWhenSecretMissing guards every step behind a configuration check', async () => {
    const { yaml } = await run(
      (app) =>
        new CloudflareDeploy(app, 'deploy', {
          skipWhenSecretMissing: true,
          preSteps: [{ name: 'Pre', run: 'x', if: 'always()' }],
          targets: [{ kind: 'worker' }],
        }),
    );
    const steps = yaml(DEPLOY).jobs.deploy.steps;
    expect(steps[0].id).toBe('cloudflare-config');
    expect(steps[0].if).toBeUndefined();
    expect(steps[0].run).toContain('"$CLOUDFLARE_API_TOKEN"');
    expect(steps[0].run).not.toContain('${{');
    const guard = "steps.cloudflare-config.outputs.configured == 'true'";
    expect(steps.slice(1).every((s: any) => s.if?.endsWith(guard))).toBe(true);
    expect(steps.find((s: any) => s.name === 'Pre').if).toBe(`(always()) && ${guard}`);
  });

  it('refuses shell metacharacters in interpolated names', () => {
    const bad = (t: any) => () => new CloudflareDeploy(new App(), 'd', { targets: [t] });
    expect(bad({ kind: 'worker', d1Migrations: { database: 'db; rm -rf /' } })).toThrow(/database/);
    expect(bad({ kind: 'pages', directory: 'dist && x' })).toThrow(/directory/);
    expect(() => new CloudflareDeploy(new App(), 'd', { targets: [] })).toThrow(/target/);
  });

  it('is deterministic', async () => {
    const mk = () =>
      run(
        (app) =>
          new CloudflareDeploy(app, 'deploy', {
            environment: 'production',
            targets: [
              { kind: 'worker', d1Migrations: { database: 'a' } },
              { kind: 'pages', directory: 'dist' },
            ],
          }),
      ).then((x) => x.file(DEPLOY)!.content);
    expect(await mk()).toBe(await mk());
  });
});

function ci_job() {
  const app = new App();
  return new NodeCi(app, 'other').job;
}

describe('BrainLint', () => {
  it('standalone workflow from npm', async () => {
    const { r, yaml } = await run((app) => new BrainLint(app, 'brain', { cliVersion: '0.14.0' }));
    const wf = yaml('.github/workflows/brain.yml');
    expect(wf.permissions).toEqual({ contents: 'read' });
    const steps = wf.jobs.lint.steps;
    expect(steps.map((s: any) => s.name ?? s.uses.split('@')[0])).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'Install brain CLI',
      'brain lint',
    ]);
    expect(steps[2].run).toBe('npm install --global @craftvalue/delivery-brain@0.14.0');
    expect(steps[2].env).toBeUndefined();
    expect(errors(r)).toEqual([]);
  });

  it('GitHub Packages: packages: read, token via NODE_AUTH_TOKEN, scoped setup-node', async () => {
    const { r, yaml } = await run(
      (app) =>
        new BrainLint(app, 'brain', {
          cliVersion: '0.14.0',
          registry: 'github',
          command: 'brain lint --quiet',
          extraCommands: { 'Build site': 'pnpm build:brain-site' },
        }),
    );
    const wf = yaml('.github/workflows/brain.yml');
    expect(wf.permissions).toEqual({ contents: 'read', packages: 'read' });
    const steps = wf.jobs.lint.steps;
    expect(steps[1].with).toEqual({
      'node-version': 22,
      'registry-url': 'https://npm.pkg.github.com',
      scope: '@craftvalueorg',
    });
    expect(steps[2].run).toBe('npm install --global @craftvalueorg/delivery-brain@0.14.0');
    expect(steps[2].env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' });
    expect(steps.slice(-2).map((s: any) => s.run)).toEqual(['brain lint --quiet', 'pnpm build:brain-site']);
    expect(errors(r)).toEqual([]);
  });

  it('appends to an existing job and grants packages: read on the workflow', async () => {
    const { yaml } = await run((app) => {
      const ci = new NodeCi(app, 'ci', { cikickCheck: false });
      new BrainLint(app, 'brain', { cliVersion: '1.2.3', registry: 'github', job: ci.job });
    });
    const wf = yaml(CI);
    expect(wf.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(
      wf.jobs.check.steps
        .map((s: any) => s.name)
        .filter(Boolean)
        .slice(-3),
    ).toEqual(['Test', 'Install brain CLI', 'brain lint']);
  });

  it('requires a pinned, shell-safe version', () => {
    const bad = (v: string) => () => new BrainLint(new App(), 'b', { cliVersion: v });
    expect(bad('latest')).toThrow();
    expect(bad('1.0.0; curl x')).toThrow(/cliVersion/);
  });
});

describe('ReleasePlease extensions', () => {
  it('packagesConfig writes per-package config in kebab-case', async () => {
    const { file } = await run(
      (app) =>
        new ReleasePlease(app, 'rp', {
          packagesConfig: {
            '.': { packageName: 'apparthunt', changelogPath: 'CHANGELOG.md', extraFiles: ['a.json'] },
          },
          initialVersion: '0.0.0',
        }),
    );
    const cfg = JSON.parse(file('release-please-config.json')!.content);
    expect(cfg.packages).toEqual({
      '.': { 'package-name': 'apparthunt', 'changelog-path': 'CHANGELOG.md', 'extra-files': ['a.json'] },
    });
    expect(cfg['include-component-in-tag']).toBeUndefined();
    expect(JSON.parse(file('.release-please-manifest.json')!.content)).toEqual({ '.': '0.0.0' });
  });

  it('packagesConfig keys must be listed packages; packages default to its keys', async () => {
    expect(() => new ReleasePlease(new App(), 'rp', { packages: ['a'], packagesConfig: { b: {} } })).toThrow(/"b"/);
    const { file } = await run(
      (app) => new ReleasePlease(app, 'rp', { packagesConfig: { 'packages/a': { releaseType: 'node' } } }),
    );
    expect(JSON.parse(file('release-please-config.json')!.content).packages).toEqual({
      'packages/a': { 'release-type': 'node' },
    });
  });

  it('includeComponentInTag overrides the monorepo default and can be set on a single package', async () => {
    const mono = await run(
      (app) => new ReleasePlease(app, 'rp', { packages: ['a', 'b'], includeComponentInTag: false }),
    );
    expect(JSON.parse(mono.file('release-please-config.json')!.content)['include-component-in-tag']).toBe(false);
    const single = await run((app) => new ReleasePlease(app, 'rp', { includeComponentInTag: true }));
    expect(JSON.parse(single.file('release-please-config.json')!.content)['include-component-in-tag']).toBe(true);
  });

  it('token with GITHUB_TOKEN fallback', async () => {
    const { app, r, yaml } = await run(
      (app) => new ReleasePlease(app, 'rp', { token: { secret: 'RELEASE_PLEASE_TOKEN', fallbackToGithubToken: true } }),
    );
    const wf = yaml('.github/workflows/release-please.yml');
    expect(wf.jobs['release-please'].steps[0].with.token).toBe('${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}');
    expect(wf.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    expect(secretsManifest(app).map((s) => s.name)).toEqual(['RELEASE_PLEASE_TOKEN']);
    expect(errors(r)).toEqual([]);
  });

  it('token without fallback drops workflow permissions; excludes appToken', async () => {
    const { yaml } = await run((app) => new ReleasePlease(app, 'rp', { token: { secret: 'PAT' } }));
    const wf = yaml('.github/workflows/release-please.yml');
    expect(wf.jobs['release-please'].steps[0].with.token).toBe('${{ secrets.PAT }}');
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(() => new ReleasePlease(new App(), 'rp', { token: { secret: 'PAT' }, appToken: {} })).toThrow(/mutually/);
  });
});
