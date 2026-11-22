import type { GitHubClient } from './client.js';
import { isRepoName } from './config.js';
import type { FleetConfig } from './types.js';

export interface AdminRepo {
  full_name: string;
  private?: boolean;
  archived?: boolean;
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** List repos the authenticated user can administer. */
export async function listAdminRepos(client: GitHubClient, opts: { owner?: string; filter?: string } = {}): Promise<AdminRepo[]> {
  const all = await client.paginate('GET /user/repos', { affiliation: 'owner,collaborator,organization_member' });
  let repos = all.filter((r) => r?.permissions?.admin) as AdminRepo[];
  if (opts.owner) {
    const o = opts.owner.toLowerCase();
    repos = repos.filter((r) => r.full_name.split('/')[0].toLowerCase() === o);
  }
  if (opts.filter) {
    const re = globToRegExp(opts.filter);
    // glob may match the full name or the bare repo name
    repos = repos.filter((r) => re.test(r.full_name) || re.test(r.full_name.split('/')[1]));
  }
  return repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export interface SelectChange {
  add?: string[];
  remove?: string[];
  group?: string;
}

/** Pure: apply add/remove (and optional group membership) to a config. */
export function applySelectionChange(config: FleetConfig, change: SelectChange): FleetConfig {
  for (const r of [...(change.add ?? []), ...(change.remove ?? [])]) {
    if (!isRepoName(r)) throw new Error(`Invalid repository "${r}", expected owner/repo`);
  }
  const repos = new Set(config.repos);
  const groups: Record<string, string[]> = Object.fromEntries(Object.entries(config.groups ?? {}).map(([k, v]) => [k, [...v]]));
  for (const r of change.add ?? []) {
    repos.add(r);
    if (change.group) (groups[change.group] ??= []).push(r);
  }
  for (const r of change.remove ?? []) {
    repos.delete(r);
    for (const g of Object.keys(groups)) groups[g] = groups[g].filter((x) => x !== r);
  }
  for (const g of Object.keys(groups)) {
    groups[g] = [...new Set(groups[g])].sort();
    if (!groups[g].length) delete groups[g];
  }
  const out: FleetConfig = { ...config, repos: [...repos].sort() };
  if (Object.keys(groups).length) out.groups = groups;
  else delete out.groups;
  return out;
}

/** Pure: replace the selection (or one group's membership) with an interactively chosen list. */
export function applyChosen(config: FleetConfig, chosen: string[], group?: string): FleetConfig {
  if (group) {
    const repos = [...new Set([...config.repos, ...chosen])].sort();
    return { ...config, repos, groups: { ...(config.groups ?? {}), [group]: [...new Set(chosen)].sort() } };
  }
  const keep = new Set(chosen);
  const groups = Object.fromEntries(
    Object.entries(config.groups ?? {})
      .map(([g, l]) => [g, l.filter((r) => keep.has(r))] as const)
      .filter(([, l]) => l.length),
  );
  const out: FleetConfig = { ...config, repos: [...keep].sort() };
  if (Object.keys(groups).length) out.groups = groups;
  else delete out.groups;
  return out;
}

/** Non-interactive add: verifies the user has admin on each added repo before selecting it. */
export async function selectNonInteractive(client: GitHubClient, config: FleetConfig, change: SelectChange): Promise<FleetConfig> {
  for (const r of change.add ?? []) {
    if (!isRepoName(r)) throw new Error(`Invalid repository "${r}", expected owner/repo`);
    const [owner, repo] = r.split('/');
    const { data } = await client.request('GET /repos/{owner}/{repo}', { owner, repo });
    if (!data?.permissions?.admin) throw new Error(`You do not have admin permission on ${r}`);
  }
  return applySelectionChange(config, change);
}
