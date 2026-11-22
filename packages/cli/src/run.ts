import {
  Checks,
  GitHubResolver,
  GitResolver,
  FallbackResolver,
  checkDrift,
  emptyLockfile,
  readLockfile,
  synth,
  writeLockfile,
  writeSynthResult,
  type ActionResolver,
  type Finding,
  type Lockfile,
  type SynthResult,
} from '@cikick/core';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { discoverPackages, installedVersions, type CikickPackage } from './packages.js';

export interface RunOptions {
  repoDir?: string;
  frozen?: boolean;
  refresh?: boolean;
  /** Override resolver (tests); defaults to GitHubResolver using GITHUB_TOKEN when not frozen. */
  resolver?: ActionResolver;
  log?: (msg: string) => void;
}

export interface SynthRun {
  result: SynthResult;
  repoDir: string;
  packages: CikickPackage[];
  hasErrors: boolean;
}

export const hasErrors = (f: Finding[]) => f.some((x) => x.severity === 'error');

export function formatFinding(f: Finding): string {
  return `${f.severity.toUpperCase().padEnd(5)} [${f.checkId}]${f.path ? ' ' + f.path + ':' : ''} ${f.message}`;
}

/** Load config + packages and compute a synth result without writing anything. */
export async function computeSynth(opts: RunOptions = {}): Promise<SynthRun> {
  const repoDir = resolve(opts.repoDir ?? process.cwd());
  const packages = await discoverPackages(repoDir);
  const { app } = await loadConfig(repoDir, (a) => {
    for (const p of packages) for (const c of p.exports.checks ?? []) Checks.of(a).add(c);
  });
  const lock: Lockfile = readLockfile(repoDir) ?? emptyLockfile();
  const resolver = opts.resolver ?? (opts.frozen ? undefined : new FallbackResolver(new GitResolver(), new GitHubResolver({ token: process.env.GITHUB_TOKEN || undefined })));
  const result = await synth(app, {
    repoDir,
    resolver,
    frozen: opts.frozen,
    refresh: opts.refresh,
    lock,
    packages: { ...lock.packages, ...installedVersions(packages) },
  });
  return { result, repoDir, packages, hasErrors: hasErrors(result.findings) };
}

export interface SynthOutcome extends SynthRun {
  written: string[];
  skipped: string[];
}

export async function runSynth(opts: RunOptions = {}): Promise<SynthOutcome> {
  const run = await computeSynth(opts);
  const { written, skipped } = writeSynthResult(run.result, run.repoDir);
  const log = opts.log ?? (() => {});
  for (const w of written) log(`wrote ${w}`);
  for (const s of skipped) log(`kept  ${s} (seeded)`);
  for (const f of run.result.findings) log(formatFinding(f));
  return { ...run, written, skipped };
}

export interface CheckOutcome extends SynthRun {
  drift: string[];
  ok: boolean;
}

export async function runCheck(opts: RunOptions = {}): Promise<CheckOutcome> {
  const run = await computeSynth({ ...opts, frozen: true });
  const drift = checkDrift(run.result, run.repoDir);
  const log = opts.log ?? (() => {});
  for (const d of drift) log(`drift: ${d}`);
  for (const f of run.result.findings) log(formatFinding(f));
  return { ...run, drift, ok: drift.length === 0 && !run.hasErrors };
}

/** Resolve / update the lockfile only. */
export async function runLock(opts: RunOptions = {}): Promise<SynthRun> {
  const run = await computeSynth({ ...opts, frozen: false });
  writeLockfile(run.repoDir, run.result.lock);
  opts.log?.('wrote cikick.lock.json');
  return run;
}
