import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FleetConfig, SecretPolicy, SettingsPolicy } from './types.js';

export const DEFAULT_CONFIG_PATH = 'fleet.json';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class ConfigError extends Error {}

export function isRepoName(s: unknown): s is string {
  return typeof s === 'string' && REPO_RE.test(s);
}

function fail(path: string, msg: string): never {
  throw new ConfigError(`Invalid fleet config: ${path}: ${msg}`);
}

function repoList(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(path, 'expected an array of "owner/repo" strings');
  v.forEach((r, i) => {
    if (!isRepoName(r)) fail(`${path}[${i}]`, `expected "owner/repo", got ${JSON.stringify(r)}`);
  });
  return v as string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf(v: unknown, path: string, allowed: string[]): void {
  if (!allowed.includes(v as string)) fail(path, `expected one of ${allowed.join(', ')}`);
}

function optBool(v: unknown, path: string): void {
  if (v !== undefined && typeof v !== 'boolean') fail(path, 'expected boolean');
}

function validateSettingsPolicy(p: unknown): SettingsPolicy {
  if (!isObj(p)) fail('settingsPolicy', 'expected an object');
  if (p.defaultWorkflowPermissions !== undefined) oneOf(p.defaultWorkflowPermissions, 'settingsPolicy.defaultWorkflowPermissions', ['read', 'write']);
  optBool(p.canApprovePullRequestReviews, 'settingsPolicy.canApprovePullRequestReviews');
  if (p.allowedActions !== undefined) oneOf(p.allowedActions, 'settingsPolicy.allowedActions', ['all', 'local_only', 'selected']);
  if (p.selectedActions !== undefined) {
    const s = p.selectedActions;
    if (!isObj(s)) fail('settingsPolicy.selectedActions', 'expected an object');
    optBool(s.githubOwnedAllowed, 'settingsPolicy.selectedActions.githubOwnedAllowed');
    optBool(s.verifiedAllowed, 'settingsPolicy.selectedActions.verifiedAllowed');
    if (s.patternsAllowed !== undefined && !(Array.isArray(s.patternsAllowed) && s.patternsAllowed.every((x) => typeof x === 'string')))
      fail('settingsPolicy.selectedActions.patternsAllowed', 'expected string[]');
  }
  if (p.requireRuleset !== undefined) {
    const r = p.requireRuleset;
    if (!isObj(r) || typeof r.branch !== 'string' || !r.branch) fail('settingsPolicy.requireRuleset', 'expected { branch: string }');
  }
  return p as SettingsPolicy;
}

function validateSecretPolicy(p: unknown, i: number, config: { repos: string[]; groups: Record<string, string[]> }): SecretPolicy {
  const at = `secretPolicies[${i}]`;
  if (!isObj(p)) fail(at, 'expected an object');
  if (typeof p.name !== 'string' || !p.name) fail(`${at}.name`, 'expected non-empty string');
  oneOf(p.scope, `${at}.scope`, ['repo', 'env']);
  if (p.scope === 'env' && (typeof p.environment !== 'string' || !p.environment)) fail(`${at}.environment`, 'required when scope is "env"');
  if (typeof p.maxAgeDays !== 'number' || !(p.maxAgeDays > 0)) fail(`${at}.maxAgeDays`, 'expected positive number');
  if (p.repos !== undefined) {
    for (const r of repoList(p.repos, `${at}.repos`)) if (!config.repos.includes(r)) fail(`${at}.repos`, `${r} is not in "repos"`);
  }
  if (p.group !== undefined && (typeof p.group !== 'string' || !config.groups[p.group])) fail(`${at}.group`, `unknown group ${JSON.stringify(p.group)}`);
  return p as unknown as SecretPolicy;
}

export function validateConfig(raw: unknown): FleetConfig {
  if (!isObj(raw)) fail('$', 'expected an object');
  const repos = repoList(raw.repos, 'repos');
  const groups: Record<string, string[]> = {};
  if (raw.groups !== undefined) {
    if (!isObj(raw.groups)) fail('groups', 'expected an object of name -> repo[]');
    for (const [g, list] of Object.entries(raw.groups)) {
      groups[g] = repoList(list, `groups.${g}`);
      for (const r of groups[g]) if (!repos.includes(r)) fail(`groups.${g}`, `${r} is not in "repos"`);
    }
  }
  const cfg: FleetConfig = { repos };
  if (raw.groups !== undefined) cfg.groups = groups;
  if (raw.settingsPolicy !== undefined) cfg.settingsPolicy = validateSettingsPolicy(raw.settingsPolicy);
  if (raw.secretPolicies !== undefined) {
    if (!Array.isArray(raw.secretPolicies)) fail('secretPolicies', 'expected an array');
    cfg.secretPolicies = raw.secretPolicies.map((p, i) => validateSecretPolicy(p, i, { repos, groups }));
  }
  return cfg;
}

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): FleetConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read fleet config at ${path}. Run "cikick-fleet select" to create one.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`Invalid fleet config: ${path} is not valid JSON (${(e as Error).message})`);
  }
  return validateConfig(raw);
}

/** Load the config, or an empty selection if the file does not exist yet. */
export function loadConfigOrEmpty(path: string = DEFAULT_CONFIG_PATH): FleetConfig {
  return existsSync(path) ? loadConfig(path) : { repos: [] };
}

export function saveConfig(path: string, config: FleetConfig): void {
  const ordered: FleetConfig = { repos: [...config.repos].sort() };
  if (config.groups && Object.keys(config.groups).length) ordered.groups = config.groups;
  if (config.settingsPolicy) ordered.settingsPolicy = config.settingsPolicy;
  if (config.secretPolicies) ordered.secretPolicies = config.secretPolicies;
  writeFileSync(path, JSON.stringify(ordered, null, 2) + '\n');
}
