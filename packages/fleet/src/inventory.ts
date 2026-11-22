import { GENERATED_HEADER, LOCKFILE_NAME, type Lockfile } from '@cikick/core';
import { getOrUndefined, errMessage, type GitHubClient } from './client.js';
import { parseRepo } from './selection.js';

export interface WorkflowInfo {
  path: string;
  generated: boolean;
  usesRefs: string[];
  unpinned: string[];
}

export interface RepoInventory {
  repo: string;
  adopted: boolean;
  lock?: Lockfile;
  packages: Record<string, string>;
  workflows: WorkflowInfo[];
  unpinnedCount: number;
  error?: string;
}

export interface PackageSummary {
  name: string;
  max: string;
  versions: Record<string, string[]>; // version -> repos
  outdated: { repo: string; version: string }[];
}

export interface InventoryResult {
  repos: RepoInventory[];
  packages: PackageSummary[];
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** Extract `uses:` references from workflow YAML text. Local and docker refs are ignored. */
export function extractUses(yaml: string): string[] {
  const out: string[] = [];
  for (const line of yaml.split('\n')) {
    const m = /^\s*(?:-\s+)?uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line);
    if (!m) continue;
    const ref = m[1] ?? m[2] ?? m[3];
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    out.push(ref);
  }
  return out;
}

export function isUnpinned(ref: string): boolean {
  const at = ref.lastIndexOf('@');
  if (at < 0) return true;
  return !SHA_RE.test(ref.slice(at + 1));
}

export function hasGeneratedHeader(text: string): boolean {
  return text.trimStart().startsWith(GENERATED_HEADER);
}

export function analyzeWorkflow(path: string, text: string): WorkflowInfo {
  const usesRefs = extractUses(text);
  return { path, generated: hasGeneratedHeader(text), usesRefs, unpinned: usesRefs.filter(isUnpinned) };
}

function decodeFile(data: any): string {
  return Buffer.from(String(data.content ?? ''), (data.encoding as BufferEncoding) || 'base64').toString('utf8');
}

async function readText(client: GitHubClient, owner: string, repo: string, path: string): Promise<string | undefined> {
  const data = await getOrUndefined(client, 'GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path });
  if (!data || Array.isArray(data) || data.type === 'dir') return undefined;
  return decodeFile(data);
}

export async function inventoryRepo(client: GitHubClient, full: string): Promise<RepoInventory> {
  const { owner, repo } = parseRepo(full);
  const res: RepoInventory = { repo: full, adopted: false, packages: {}, workflows: [], unpinnedCount: 0 };
  try {
    const lockText = await readText(client, owner, repo, LOCKFILE_NAME);
    if (lockText !== undefined) {
      try {
        const lock = JSON.parse(lockText) as Lockfile;
        res.adopted = true;
        res.lock = lock;
        res.packages = lock.packages ?? {};
      } catch {
        res.error = `${LOCKFILE_NAME} is not valid JSON`;
      }
    }
    const dir = await getOrUndefined(client, 'GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: '.github/workflows',
    });
    const files = (Array.isArray(dir) ? dir : []).filter((f: any) => f.type === 'file' && /\.ya?ml$/i.test(f.name));
    for (const f of files) {
      const text = await readText(client, owner, repo, f.path ?? `.github/workflows/${f.name}`);
      res.workflows.push(analyzeWorkflow(f.path ?? `.github/workflows/${f.name}`, text ?? ''));
    }
    res.unpinnedCount = res.workflows.reduce((n, w) => n + w.unpinned.length, 0);
  } catch (e) {
    res.error = errMessage(e);
  }
  return res;
}

/** Compare dotted numeric versions (prerelease suffix ignored beyond numeric core). */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .split(/[-+]/)[0]
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
  const pb = b
    .split(/[-+]/)[0]
    .split('.')
    .map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function summarizePackages(repos: RepoInventory[]): PackageSummary[] {
  const byName = new Map<string, Map<string, string[]>>();
  for (const r of repos) {
    for (const [name, version] of Object.entries(r.packages)) {
      const vm = byName.get(name) ?? new Map<string, string[]>();
      vm.set(version, [...(vm.get(version) ?? []), r.repo]);
      byName.set(name, vm);
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, vm]) => {
      const versions = [...vm.keys()].sort(compareVersions);
      const max = versions[versions.length - 1];
      return {
        name,
        max,
        versions: Object.fromEntries(versions.map((v) => [v, vm.get(v)!])),
        outdated: versions
          .filter((v) => compareVersions(v, max) < 0)
          .flatMap((v) => vm.get(v)!.map((repo) => ({ repo, version: v }))),
      };
    });
}

export async function inventory(client: GitHubClient, targets: string[]): Promise<InventoryResult> {
  const repos: RepoInventory[] = [];
  for (const t of targets) repos.push(await inventoryRepo(client, t));
  return { repos, packages: summarizePackages(repos) };
}
