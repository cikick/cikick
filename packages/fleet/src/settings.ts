import { errMessage, errorStatus, getOrUndefined, type GitHubClient } from './client.js';
import { parseRepo } from './selection.js';
import type { SettingsPolicy } from './types.js';

export interface RepoSettingsState {
  actionsEnabled?: boolean;
  allowedActions?: 'all' | 'local_only' | 'selected';
  defaultWorkflowPermissions?: 'read' | 'write';
  canApprovePullRequestReviews?: boolean;
  selectedActions?: { githubOwnedAllowed?: boolean; verifiedAllowed?: boolean; patternsAllowed?: string[] };
  rulesetBranches?: string[]; // branch patterns covered by active rulesets
  rulesetPresent?: boolean; // for the policy branch
  branchProtected?: boolean;
}

export interface SettingDiff {
  key: string;
  desired: unknown;
  actual: unknown;
  status: 'ok' | 'drift' | 'report';
}

export interface RepoSettingsDiff {
  repo: string;
  diffs: SettingDiff[];
  error?: string;
}

export async function readRepoSettings(client: GitHubClient, full: string, policy: SettingsPolicy): Promise<RepoSettingsState> {
  const { owner, repo } = parseRepo(full);
  const p = { owner, repo };
  const s: RepoSettingsState = {};
  const perms = await client.request('GET /repos/{owner}/{repo}/actions/permissions', p);
  s.actionsEnabled = perms.data.enabled;
  s.allowedActions = perms.data.allowed_actions;
  const wf = await client.request('GET /repos/{owner}/{repo}/actions/permissions/workflow', p);
  s.defaultWorkflowPermissions = wf.data.default_workflow_permissions;
  s.canApprovePullRequestReviews = wf.data.can_approve_pull_request_reviews;
  if (s.allowedActions === 'selected' && (policy.selectedActions || policy.allowedActions === 'selected')) {
    const sel = await getOrUndefined(client, 'GET /repos/{owner}/{repo}/actions/permissions/selected-actions', p);
    if (sel)
      s.selectedActions = {
        githubOwnedAllowed: sel.github_owned_allowed,
        verifiedAllowed: sel.verified_allowed,
        patternsAllowed: sel.patterns_allowed ?? [],
      };
  }
  if (policy.requireRuleset) {
    const branch = policy.requireRuleset.branch;
    const rulesets = (await getOrUndefined(client, 'GET /repos/{owner}/{repo}/rulesets', p)) ?? [];
    const covering: string[] = [];
    for (const rs of rulesets as any[]) {
      if (rs.enforcement === 'disabled' || (rs.target && rs.target !== 'branch')) continue;
      let detail = rs;
      if (!rs.conditions && rs.id !== undefined) {
        detail = (await getOrUndefined(client, 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', { ...p, ruleset_id: rs.id })) ?? rs;
      }
      const inc: string[] = detail.conditions?.ref_name?.include ?? [];
      if (inc.includes(`refs/heads/${branch}`) || inc.includes('~DEFAULT_BRANCH') || inc.includes('~ALL')) covering.push(...inc);
    }
    s.rulesetBranches = covering;
    s.rulesetPresent = covering.length > 0;
    try {
      const prot = await getOrUndefined(client, 'GET /repos/{owner}/{repo}/branches/{branch}/protection', { ...p, branch });
      s.branchProtected = prot !== undefined;
    } catch (e) {
      if (errorStatus(e) !== 403) throw e;
      s.branchProtected = false;
    }
  }
  return s;
}

const sameSet = (a: string[] = [], b: string[] = []) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function diffSettings(state: RepoSettingsState, policy: SettingsPolicy): SettingDiff[] {
  const out: SettingDiff[] = [];
  const cmp = (key: string, desired: unknown, actual: unknown, eq = desired === actual) =>
    out.push({ key, desired, actual, status: eq ? 'ok' : 'drift' });
  if (policy.defaultWorkflowPermissions !== undefined) cmp('defaultWorkflowPermissions', policy.defaultWorkflowPermissions, state.defaultWorkflowPermissions);
  if (policy.canApprovePullRequestReviews !== undefined) cmp('canApprovePullRequestReviews', policy.canApprovePullRequestReviews, state.canApprovePullRequestReviews);
  if (policy.allowedActions !== undefined) cmp('allowedActions', policy.allowedActions, state.allowedActions);
  const sel = policy.selectedActions;
  if (sel) {
    const act = state.selectedActions;
    if (sel.githubOwnedAllowed !== undefined) cmp('selectedActions.githubOwnedAllowed', sel.githubOwnedAllowed, act?.githubOwnedAllowed);
    if (sel.verifiedAllowed !== undefined) cmp('selectedActions.verifiedAllowed', sel.verifiedAllowed, act?.verifiedAllowed);
    if (sel.patternsAllowed !== undefined) cmp('selectedActions.patternsAllowed', sel.patternsAllowed, act?.patternsAllowed, sameSet(sel.patternsAllowed, act?.patternsAllowed));
  }
  if (policy.requireRuleset) {
    out.push({
      key: `ruleset(${policy.requireRuleset.branch})`,
      desired: 'present',
      actual: state.rulesetPresent ? 'ruleset' : state.branchProtected ? 'branch protection only' : 'none',
      status: state.rulesetPresent ? 'ok' : 'report',
    });
  }
  return out;
}

export async function settingsDiff(client: GitHubClient, targets: string[], policy: SettingsPolicy | undefined): Promise<RepoSettingsDiff[]> {
  if (!policy) throw new Error('No settingsPolicy defined in fleet config.');
  const res: RepoSettingsDiff[] = [];
  for (const repo of targets) {
    try {
      res.push({ repo, diffs: diffSettings(await readRepoSettings(client, repo, policy), policy) });
    } catch (e) {
      res.push({ repo, diffs: [], error: errMessage(e) });
    }
  }
  return res;
}

export interface ApplyAction {
  repo: string;
  description: string;
  applied: boolean;
  error?: string;
}

export interface ApplyResult {
  dryRun: boolean;
  actions: ApplyAction[];
  report: { repo: string; key: string; actual: unknown }[];
}

/** Compute and (when !dryRun) perform the PUTs needed to bring each repo in line. Rulesets are report-only. */
export async function settingsApply(
  client: GitHubClient,
  targets: string[],
  policy: SettingsPolicy | undefined,
  opts: { dryRun: boolean },
): Promise<ApplyResult> {
  const diffs = await settingsDiff(client, targets, policy);
  const result: ApplyResult = { dryRun: opts.dryRun, actions: [], report: [] };
  for (const d of diffs) {
    if (d.error) {
      result.actions.push({ repo: d.repo, description: 'read settings', applied: false, error: d.error });
      continue;
    }
    const { owner, repo } = parseRepo(d.repo);
    const p = { owner, repo };
    const drift = new Map(d.diffs.filter((x) => x.status === 'drift').map((x) => [x.key, x]));
    for (const x of d.diffs) if (x.status === 'report') result.report.push({ repo: d.repo, key: x.key, actual: x.actual });
    const puts: { description: string; route: string; body: Record<string, unknown> }[] = [];
    if (drift.has('allowedActions')) {
      puts.push({
        description: `allowedActions -> ${policy!.allowedActions}`,
        route: 'PUT /repos/{owner}/{repo}/actions/permissions',
        body: { enabled: true, allowed_actions: policy!.allowedActions },
      });
    }
    if (drift.has('defaultWorkflowPermissions') || drift.has('canApprovePullRequestReviews')) {
      const body: Record<string, unknown> = {};
      const parts: string[] = [];
      if (drift.has('defaultWorkflowPermissions')) {
        body.default_workflow_permissions = policy!.defaultWorkflowPermissions;
        parts.push(`defaultWorkflowPermissions -> ${policy!.defaultWorkflowPermissions}`);
      }
      if (drift.has('canApprovePullRequestReviews')) {
        body.can_approve_pull_request_reviews = policy!.canApprovePullRequestReviews;
        parts.push(`canApprovePullRequestReviews -> ${policy!.canApprovePullRequestReviews}`);
      }
      puts.push({ description: parts.join(', '), route: 'PUT /repos/{owner}/{repo}/actions/permissions/workflow', body });
    }
    const selKeys = [...drift.keys()].filter((k) => k.startsWith('selectedActions.'));
    if (selKeys.length) {
      const s = policy!.selectedActions!;
      const body: Record<string, unknown> = {};
      if (s.githubOwnedAllowed !== undefined) body.github_owned_allowed = s.githubOwnedAllowed;
      if (s.verifiedAllowed !== undefined) body.verified_allowed = s.verifiedAllowed;
      if (s.patternsAllowed !== undefined) body.patterns_allowed = s.patternsAllowed;
      puts.push({ description: `selected actions: ${selKeys.map((k) => k.split('.')[1]).join(', ')}`, route: 'PUT /repos/{owner}/{repo}/actions/permissions/selected-actions', body });
    }
    for (const put of puts) {
      const action: ApplyAction = { repo: d.repo, description: put.description, applied: false };
      if (!opts.dryRun) {
        try {
          await client.request(put.route, { ...p, ...put.body });
          action.applied = true;
        } catch (e) {
          action.error = errMessage(e);
        }
      }
      result.actions.push(action);
    }
  }
  return result;
}
