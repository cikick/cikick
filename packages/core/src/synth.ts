import type { IConstruct } from 'constructs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { isSha, type ActionRef } from './action-ref.js';
import type { App } from './app.js';
import { applyAspects } from './aspects.js';
import { runChecks, type Finding, type RepoSettings } from './checks.js';
import {
  LOCKFILE_NAME,
  emptyLockfile,
  readLockfile,
  serializeLockfile,
  type Lockfile,
  type LockedAction,
} from './lockfile.js';
import { GENERATED_HEADER, ManagedFile, type ManagedFileMode } from './managed-file.js';
import { LockResolver, type ActionResolver } from './resolver.js';
import { REF_COMMENT_MARK, Workflow } from './workflow.js';

export interface SynthFile {
  path: string;
  content: string;
  mode: ManagedFileMode;
}

export interface SynthResult {
  files: SynthFile[];
  lock: Lockfile;
  findings: Finding[];
}

export interface SynthOptions {
  repoDir: string;
  resolver?: ActionResolver;
  /** Error if any non-SHA action ref is missing from the lock. */
  frozen?: boolean;
  now?: Date;
  /** Lock to start from; defaults to app.lock, then `<repoDir>/cikick.lock.json`, then empty. */
  lock?: Lockfile;
  /** Re-resolve all refs instead of trusting existing lock entries. */
  refresh?: boolean;
  /** cikick package versions to record in the lock (defaults to the existing lock's). */
  packages?: Record<string, string>;
  settings?: RepoSettings;
}

export class FrozenLockError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `cikick.lock.json is missing entries (frozen mode): ${missing.join(', ')}. Run \`npx cikick lock\` and commit the result.`,
    );
    this.name = 'FrozenLockError';
  }
}

export async function synth(app: App, opts: SynthOptions): Promise<SynthResult> {
  const now = opts.now ?? new Date();
  const baseLock = opts.lock ?? app.lock ?? readLockfile(opts.repoDir) ?? emptyLockfile();

  applyAspects(app);

  const nodes: IConstruct[] = app.node.findAll();
  const workflows = nodes.filter(Workflow.isWorkflow);

  // Resolve action refs
  const refsByKey = new Map<string, ActionRef[]>();
  for (const wf of workflows) {
    for (const r of wf.actionRefs()) {
      if (isSha(r.ref)) {
        r.sha = r.ref;
        continue;
      }
      const list = refsByKey.get(r.key) ?? [];
      list.push(r);
      refsByKey.set(r.key, list);
    }
  }
  const keys = [...refsByKey.keys()].sort();
  const actions: Record<string, LockedAction> = {};
  const missing: string[] = [];
  const toResolve: string[] = [];
  for (const k of keys) {
    const existing = opts.refresh ? undefined : baseLock.actions[k];
    if (existing) actions[k] = existing;
    else if (opts.frozen) missing.push(k);
    else toResolve.push(k);
  }
  if (missing.length) throw new FrozenLockError(missing);
  const resolver = opts.resolver ?? new LockResolver(baseLock);
  await Promise.all(
    toResolve.map(async (k) => {
      const r = refsByKey.get(k)![0]!;
      const sha = await resolver.resolve(r.owner, r.repo, r.ref);
      actions[k] = { sha, resolvedAt: now.toISOString() };
    }),
  );
  for (const [k, refs] of refsByKey) for (const r of refs) r.sha = actions[k]!.sha;

  // Render
  const files = new Map<string, SynthFile>();
  const add = (f: SynthFile) => {
    if (files.has(f.path)) throw new Error(`Duplicate output path: ${f.path}`);
    files.set(f.path, f);
  };
  for (const wf of workflows) add({ path: wf.filePath, content: renderWorkflowYaml(wf), mode: 'managed' });
  for (const mf of nodes.filter(ManagedFile.isManagedFile))
    add({ path: mf.path, content: mf.render(opts.repoDir), mode: mf.mode });

  const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const lock: Lockfile = { version: 1, actions, packages: opts.packages ?? baseLock.packages ?? {} };
  const findings = await runChecks(app, { repoDir: opts.repoDir, settings: opts.settings, files: sorted, now });
  return { files: sorted, lock, findings };
}

export function renderWorkflowYaml(wf: Workflow): string {
  const yaml = stringifyYaml(wf.render(true), { lineWidth: 0, indent: 2 });
  const body = yaml.replace(new RegExp(`${REF_COMMENT_MARK}(\\S+)$`, 'gm'), ' # $1');
  return `${GENERATED_HEADER}\n${body}`;
}

export interface WriteOptions {
  /** Also write cikick.lock.json (default true). */
  writeLock?: boolean;
}

export function writeSynthResult(
  result: SynthResult,
  repoDir: string,
  opts: WriteOptions = {},
): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  const put = (rel: string, content: string) => {
    const full = join(repoDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    written.push(rel);
  };
  for (const f of result.files) {
    if (f.mode === 'seeded' && existsSync(join(repoDir, f.path))) {
      skipped.push(f.path);
      continue;
    }
    put(f.path, f.content);
  }
  if (opts.writeLock !== false) put(LOCKFILE_NAME, serializeLockfile(result.lock));
  return { written, skipped };
}

/** Paths whose on-disk content differs from the synth result (missing counts as differing). Seeded files only drift when missing. */
export function checkDrift(result: SynthResult, repoDir: string, opts: WriteOptions = {}): string[] {
  const drift: string[] = [];
  const read = (rel: string) => {
    const p = join(repoDir, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };
  for (const f of result.files) {
    const cur = read(f.path);
    if (cur === undefined || (f.mode !== 'seeded' && cur !== f.content)) drift.push(f.path);
  }
  if (opts.writeLock !== false) {
    const cur = read(LOCKFILE_NAME);
    const want = serializeLockfile(result.lock);
    if (cur === undefined ? Object.keys(result.lock.actions).length > 0 : cur !== want) drift.push(LOCKFILE_NAME);
  }
  return drift;
}
