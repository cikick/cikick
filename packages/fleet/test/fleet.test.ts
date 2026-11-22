import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sodium from 'libsodium-wrappers';
import { describe, expect, it } from 'vitest';
import { GENERATED_HEADER } from '@cikick/core';
import {
  NotSelectedError,
  applySelectionChange,
  applyChosen,
  resolveTargets,
  validateConfig,
  ConfigError,
  listAdminRepos,
  selectNonInteractive,
  inventory,
  analyzeWorkflow,
  settingsDiff,
  settingsApply,
  secretsReport,
  rotateSecret,
  writeHtmlReport,
  buildProgram,
  type FleetConfig,
} from '../src/index.js';
import { b64, mockClient, notFound } from './mock.js';

const SHA = 'a'.repeat(40);
const config: FleetConfig = {
  repos: ['acme/a', 'acme/b', 'acme/c'],
  groups: { core: ['acme/a', 'acme/b'] },
};

describe('selection', () => {
  it('defaults to all selected, narrows by repos/group', () => {
    expect(resolveTargets(config)).toEqual(config.repos);
    expect(resolveTargets(config, { group: 'core' })).toEqual(['acme/a', 'acme/b']);
    expect(resolveTargets(config, { group: 'core', repos: ['acme/b'] })).toEqual(['acme/b']);
  });
  it('refuses repos outside the selection', () => {
    expect(() => resolveTargets(config, { repos: ['acme/zzz'] })).toThrow(NotSelectedError);
    expect(() => resolveTargets(config, { repos: ['acme/a', 'other/x'] })).toThrow(/other\/x/);
  });
  it('validates config with clear errors', () => {
    expect(() => validateConfig({ repos: ['nope'] })).toThrow(ConfigError);
    expect(() => validateConfig({ repos: ['a/b'], groups: { g: ['a/c'] } })).toThrow(/not in "repos"/);
    expect(() =>
      validateConfig({ repos: ['a/b'], secretPolicies: [{ name: 'X', scope: 'env', maxAgeDays: 1 }] }),
    ).toThrow(/environment/);
    expect(validateConfig(config)).toEqual(config);
  });
});

describe('select', () => {
  it('lists only admin repos with owner/filter', async () => {
    const client = mockClient({
      'GET /user/repos': [
        { full_name: 'acme/a', permissions: { admin: true } },
        { full_name: 'acme/ro', permissions: { admin: false } },
        { full_name: 'me/a-tool', permissions: { admin: true } },
      ],
    });
    expect((await listAdminRepos(client)).map((r) => r.full_name)).toEqual(['acme/a', 'me/a-tool']);
    expect((await listAdminRepos(client, { owner: 'me' })).map((r) => r.full_name)).toEqual(['me/a-tool']);
    expect((await listAdminRepos(client, { filter: '*-tool' })).map((r) => r.full_name)).toEqual(['me/a-tool']);
    expect(client.calls[0].params.affiliation).toBe('owner,collaborator,organization_member');
  });
  it('add/remove and groups', () => {
    const next = applySelectionChange(config, { add: ['acme/d'], remove: ['acme/a'], group: 'extra' });
    expect(next.repos).toEqual(['acme/b', 'acme/c', 'acme/d']);
    expect(next.groups).toEqual({ core: ['acme/b'], extra: ['acme/d'] });
    expect(applyChosen(config, ['acme/b'], undefined).groups).toEqual({ core: ['acme/b'] });
  });
  it('non-interactive add requires admin', async () => {
    const client = mockClient({
      'GET /repos/{owner}/{repo}': (p: any) => ({ permissions: { admin: p.repo === 'ok' } }),
    });
    expect((await selectNonInteractive(client, { repos: [] }, { add: ['acme/ok'] })).repos).toEqual(['acme/ok']);
    await expect(selectNonInteractive(client, { repos: [] }, { add: ['acme/no'] })).rejects.toThrow(/admin/);
  });
});

describe('inventory', () => {
  it('detects unpinned refs and generated headers', () => {
    const w = analyzeWorkflow(
      '.github/workflows/ci.yml',
      `${GENERATED_HEADER}\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v4\n      - uses: actions/setup-node@v4\n      - uses: ./local\n      - uses: docker://alpine:3\n      - uses: foo/bar\n`,
    );
    expect(w.generated).toBe(true);
    expect(w.unpinned).toEqual(['actions/setup-node@v4', 'foo/bar']);
    expect(analyzeWorkflow('x.yml', 'name: x\n').generated).toBe(false);
  });
  it('reads lock + workflows; summarizes versions', async () => {
    const lock = (v: string) => b64(JSON.stringify({ version: 1, actions: {}, packages: { '@cikick/core': v } }));
    const client = mockClient({
      'GET /repos/{owner}/{repo}/contents/{path}': (p: any) => {
        if (p.repo === 'a') {
          if (p.path === 'cikick.lock.json') return { type: 'file', encoding: 'base64', content: lock('1.2.0') };
          if (p.path === '.github/workflows')
            return [{ type: 'file', name: 'ci.yml', path: '.github/workflows/ci.yml' }];
          return { type: 'file', encoding: 'base64', content: b64(`${GENERATED_HEADER}\n- uses: a/b@v1\n`) };
        }
        if (p.repo === 'b') {
          if (p.path === 'cikick.lock.json') return { type: 'file', encoding: 'base64', content: lock('1.0.0') };
          if (p.path === '.github/workflows') return [];
        }
        return notFound();
      },
    });
    const res = await inventory(client, ['acme/a', 'acme/b', 'acme/c']);
    expect(res.repos.map((r) => r.adopted)).toEqual([true, true, false]);
    expect(res.repos[0].unpinnedCount).toBe(1);
    expect(res.repos[0].workflows[0].generated).toBe(true);
    expect(res.packages[0]).toMatchObject({
      name: '@cikick/core',
      max: '1.2.0',
      outdated: [{ repo: 'acme/b', version: '1.0.0' }],
    });
  });
});

describe('settings', () => {
  const state = { enabled: true, allowed_actions: 'all' };
  const make = () => {
    const puts: any[] = [];
    const client = mockClient({
      'GET /repos/{owner}/{repo}/actions/permissions': state,
      'GET /repos/{owner}/{repo}/actions/permissions/workflow': {
        default_workflow_permissions: 'write',
        can_approve_pull_request_reviews: false,
      },
      'GET /repos/{owner}/{repo}/rulesets': [],
      'GET /repos/{owner}/{repo}/branches/{branch}/protection': notFound,
      'PUT /repos/{owner}/{repo}/actions/permissions/workflow': (p: any) => {
        puts.push(p);
        return {};
      },
      'PUT /repos/{owner}/{repo}/actions/permissions': (p: any) => {
        puts.push(p);
        return {};
      },
    });
    return { client, puts };
  };
  const policy = {
    defaultWorkflowPermissions: 'read' as const,
    canApprovePullRequestReviews: false,
    allowedActions: 'local_only' as const,
    requireRuleset: { branch: 'main' },
  };

  it('diffs', async () => {
    const [d] = await settingsDiff(make().client, ['acme/a'], policy);
    const by = Object.fromEntries(d.diffs.map((x) => [x.key, x.status]));
    expect(by).toMatchObject({
      defaultWorkflowPermissions: 'drift',
      canApprovePullRequestReviews: 'ok',
      allowedActions: 'drift',
      'ruleset(main)': 'report',
    });
  });
  it('apply is dry-run without yes, PUTs with yes, never touches rulesets', async () => {
    const dry = make();
    const r1 = await settingsApply(dry.client, ['acme/a'], policy, { dryRun: true });
    expect(dry.puts).toHaveLength(0);
    expect(r1.actions).toHaveLength(2);
    expect(r1.report[0].key).toBe('ruleset(main)');
    const live = make();
    await settingsApply(live.client, ['acme/a'], policy, { dryRun: false });
    expect(live.puts).toHaveLength(2);
    expect(live.puts.find((p) => p.default_workflow_permissions)).toMatchObject({
      default_workflow_permissions: 'read',
    });
    expect(live.puts.find((p) => p.allowed_actions)).toMatchObject({ allowed_actions: 'local_only' });
  });
});

describe('secrets', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const cfg: FleetConfig = {
    repos: ['acme/a', 'acme/b'],
    secretPolicies: [
      { name: 'NPM_TOKEN', scope: 'repo', maxAgeDays: 90 },
      { name: 'DEPLOY_KEY', scope: 'env', environment: 'prod', maxAgeDays: 30, repos: ['acme/a'] },
      { name: 'MISSING_ONE', scope: 'repo', maxAgeDays: 10, repos: ['acme/b'] },
    ],
  };
  const client = mockClient({
    'GET /repos/{owner}/{repo}/actions/secrets': (p: any) =>
      p.repo === 'a'
        ? [
            { name: 'NPM_TOKEN', updated_at: '2026-05-20T00:00:00Z' },
            { name: 'OLD', updated_at: '2025-01-01T00:00:00Z' },
          ]
        : [
            { name: 'NPM_TOKEN', updated_at: '2025-12-01T00:00:00Z' },
            { name: 'FRESH', updated_at: '2026-05-30T00:00:00Z' },
          ],
    'GET /repos/{owner}/{repo}/environments': (p: any) => (p.repo === 'a' ? [{ name: 'prod' }] : []),
    'GET /repos/{owner}/{repo}/environments/{environment_name}/secrets': [
      { name: 'DEPLOY_KEY', updated_at: '2026-03-01T00:00:00Z' },
    ],
  });
  it('classifies', async () => {
    const rep = await secretsReport(client, cfg, cfg.repos, { now });
    const st = (repo: string, name: string) => rep.rows.find((r) => r.repo === repo && r.name === name)?.status;
    expect(st('acme/a', 'NPM_TOKEN')).toBe('ok');
    expect(st('acme/a', 'DEPLOY_KEY')).toBe('stale');
    expect(st('acme/a', 'OLD')).toBe('untracked-stale');
    expect(st('acme/b', 'NPM_TOKEN')).toBe('stale');
    expect(st('acme/b', 'MISSING_ONE')).toBe('missing');
    expect(st('acme/b', 'FRESH')).toBe('untracked');
    expect(rep.rows.find((r) => r.name === 'DEPLOY_KEY')).toMatchObject({ environment: 'prod', ageDays: 92 });
  });

  it('rotate seals decryptably; dry-run does not PUT', async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const puts: any[] = [];
    const c = mockClient({
      'GET /repos/{owner}/{repo}/actions/secrets/public-key': {
        key_id: 'k1',
        key: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
      },
      'PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}': (p: any) => {
        puts.push(p);
        return { __status: 201, data: {} };
      },
    });
    const dry = await rotateSecret(c, ['acme/a'], { name: 'TOK', value: 's3cret', dryRun: true });
    expect(dry[0].status).toBe('planned');
    expect(puts).toHaveLength(0);
    const res = await rotateSecret(c, ['acme/a', 'acme/b'], { name: 'TOK', value: 's3cret', dryRun: false });
    expect(res.map((r) => r.status)).toEqual(['created', 'created']);
    expect(JSON.stringify(res)).not.toContain('s3cret');
    expect(puts[0].key_id).toBe('k1');
    const plain = sodium.crypto_box_seal_open(
      sodium.from_base64(puts[0].encrypted_value, sodium.base64_variants.ORIGINAL),
      kp.publicKey,
      kp.privateKey,
    );
    expect(sodium.to_string(plain)).toBe('s3cret');
  });

  it('rotate env scope uses environment endpoints and reports failures', async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const c = mockClient({
      'GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key': (p: any) =>
        p.repo === 'a'
          ? { key_id: 'k', key: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL) }
          : notFound(),
      'PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}': {},
    });
    const res = await rotateSecret(c, ['acme/a', 'acme/b'], {
      name: 'T',
      environment: 'prod',
      value: 'v',
      dryRun: false,
    });
    expect(res.map((r) => r.status)).toEqual(['updated', 'failed']);
  });
});

describe('cli', () => {
  it('rotate refuses unselected repos and defaults to dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
    const file = join(dir, 'fleet.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ repos: ['acme/a'] }));
    const client = mockClient({});
    const lines: string[] = [];
    const run = (args: string[]) =>
      buildProgram({ client, out: (s) => lines.push(s), env: { V: 'x' } }).parseAsync([
        'node',
        'x',
        '-c',
        file,
        ...args,
      ]);
    await expect(run(['secrets', 'rotate', 'T', '--value-from-env', 'V', '--repos', 'acme/zzz'])).rejects.toThrow(
      NotSelectedError,
    );
    await run(['secrets', 'rotate', 'T', '--value-from-env', 'V']);
    expect(lines.join('\n')).toContain('planned');
    expect(client.calls).toHaveLength(0);
  });
});

describe('html report', () => {
  it('renders self-contained html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
    const out = join(dir, 'r.html');
    const client = mockClient({
      'GET /repos/{owner}/{repo}/contents/{path}': notFound,
      'GET /repos/{owner}/{repo}/actions/secrets': [{ name: '<script>', updated_at: '2020-01-01T00:00:00Z' }],
      'GET /repos/{owner}/{repo}/environments': [],
      'GET /repos/{owner}/{repo}/actions/permissions': { enabled: true, allowed_actions: 'all' },
      'GET /repos/{owner}/{repo}/actions/permissions/workflow': {
        default_workflow_permissions: 'write',
        can_approve_pull_request_reviews: true,
      },
    });
    const cfg: FleetConfig = { repos: ['acme/a'], settingsPolicy: { defaultWorkflowPermissions: 'read' } };
    await writeHtmlReport(client, cfg, ['acme/a'], out, { now: new Date('2026-06-01T00:00:00Z') });
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('not adopted');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('defaultWorkflowPermissions');
    expect(html).not.toMatch(/https?:\/\//);
  });
});
