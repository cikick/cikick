import sodium from 'libsodium-wrappers';
import { errMessage, getOrUndefined, type GitHubClient } from './client.js';
import { parseRepo, resolveTargets } from './selection.js';
import type { FleetConfig, SecretPolicy } from './types.js';

export const DEFAULT_MAX_AGE_DAYS = 180;
const DAY = 86_400_000;

export type SecretStatus = 'ok' | 'stale' | 'missing' | 'untracked' | 'untracked-stale';

export interface SecretRow {
  repo: string;
  name: string;
  scope: 'repo' | 'env';
  environment?: string;
  updatedAt?: string;
  ageDays?: number;
  maxAgeDays?: number;
  status: SecretStatus;
}

export interface SecretsReport {
  now: string;
  rows: SecretRow[];
  errors: { repo: string; error: string }[];
}

interface FoundSecret {
  name: string;
  scope: 'repo' | 'env';
  environment?: string;
  updated_at: string;
}

export async function listRepoSecrets(client: GitHubClient, full: string): Promise<FoundSecret[]> {
  const { owner, repo } = parseRepo(full);
  const found: FoundSecret[] = [];
  const repoSecrets = await client.paginate('GET /repos/{owner}/{repo}/actions/secrets', { owner, repo });
  for (const s of repoSecrets) found.push({ name: s.name, scope: 'repo', updated_at: s.updated_at });
  let envs: any[] = [];
  try {
    envs = await client.paginate('GET /repos/{owner}/{repo}/environments', { owner, repo });
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
  for (const env of envs) {
    const secrets = await client.paginate('GET /repos/{owner}/{repo}/environments/{environment_name}/secrets', {
      owner,
      repo,
      environment_name: env.name,
    });
    for (const s of secrets)
      found.push({ name: s.name, scope: 'env', environment: env.name, updated_at: s.updated_at });
  }
  return found;
}

export function policyTargets(config: FleetConfig, policy: SecretPolicy, targets: string[]): string[] {
  const scoped = resolveTargets(config, { repos: policy.repos, group: policy.group });
  const t = new Set(targets);
  return scoped.filter((r) => t.has(r));
}

function age(updatedAt: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(updatedAt).getTime()) / DAY);
}

export async function secretsReport(
  client: GitHubClient,
  config: FleetConfig,
  targets: string[],
  opts: { now?: Date; maxAgeDays?: number } = {},
): Promise<SecretsReport> {
  const now = opts.now ?? new Date();
  const defaultMax = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const policies = config.secretPolicies ?? [];
  const rows: SecretRow[] = [];
  const errors: SecretsReport['errors'] = [];
  for (const repo of targets) {
    let found: FoundSecret[];
    try {
      found = await listRepoSecrets(client, repo);
    } catch (e) {
      errors.push({ repo, error: errMessage(e) });
      continue;
    }
    const matched = new Set<FoundSecret>();
    for (const p of policies) {
      if (!policyTargets(config, p, [repo]).length) continue;
      const hit = found.find(
        (s) => s.name === p.name && s.scope === p.scope && (p.scope === 'repo' || s.environment === p.environment),
      );
      const base = {
        repo,
        name: p.name,
        scope: p.scope,
        environment: p.environment,
        maxAgeDays: p.maxAgeDays,
      } as const;
      if (!hit) {
        rows.push({ ...base, status: 'missing' });
        continue;
      }
      matched.add(hit);
      const a = age(hit.updated_at, now);
      rows.push({ ...base, updatedAt: hit.updated_at, ageDays: a, status: a > p.maxAgeDays ? 'stale' : 'ok' });
    }
    for (const s of found) {
      if (matched.has(s)) continue;
      const a = age(s.updated_at, now);
      rows.push({
        repo,
        name: s.name,
        scope: s.scope,
        environment: s.environment,
        updatedAt: s.updated_at,
        ageDays: a,
        maxAgeDays: defaultMax,
        status: a > defaultMax ? 'untracked-stale' : 'untracked',
      });
    }
  }
  return { now: now.toISOString(), rows, errors };
}

/** Rows needing attention (stale/missing/untracked-stale). */
export const needsAttention = (r: SecretRow) =>
  r.status === 'stale' || r.status === 'missing' || r.status === 'untracked-stale';

export async function sealSecret(publicKeyB64: string, value: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export interface RotateOptions {
  name: string;
  environment?: string;
  value: string;
  dryRun: boolean;
}

export interface RotateResult {
  repo: string;
  name: string;
  scope: 'repo' | 'env';
  environment?: string;
  status: 'planned' | 'updated' | 'created' | 'failed';
  error?: string;
}

/** Rotate a secret across the given (already resolved) targets. The value is never included in results. */
export async function rotateSecret(
  client: GitHubClient,
  targets: string[],
  opts: RotateOptions,
): Promise<RotateResult[]> {
  const scope: 'repo' | 'env' = opts.environment ? 'env' : 'repo';
  const results: RotateResult[] = [];
  for (const full of targets) {
    const base = { repo: full, name: opts.name, scope, environment: opts.environment };
    if (opts.dryRun) {
      results.push({ ...base, status: 'planned' });
      continue;
    }
    const { owner, repo } = parseRepo(full);
    const pk = opts.environment
      ? 'GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key'
      : 'GET /repos/{owner}/{repo}/actions/secrets/public-key';
    const put = opts.environment
      ? 'PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}'
      : 'PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}';
    const params = { owner, repo, environment_name: opts.environment, secret_name: opts.name };
    try {
      const key = await getOrUndefined(client, pk, params);
      if (!key)
        throw new Error(opts.environment ? `environment "${opts.environment}" not found` : 'public key not found');
      const encrypted_value = await sealSecret(key.key, opts.value);
      const res = await client.request(put, { ...params, encrypted_value, key_id: key.key_id });
      results.push({ ...base, status: res.status === 201 ? 'created' : 'updated' });
    } catch (e) {
      results.push({ ...base, status: 'failed', error: errMessage(e) });
    }
  }
  return results;
}
