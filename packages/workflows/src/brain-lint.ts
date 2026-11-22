import { Workflow, secret, type Job, type StepProps } from '@cikick/core';
import { Construct } from 'constructs';
import {
  grantPermission,
  resolveRegistryAuth,
  shellSafe,
  toolchainSteps,
  type GitHubPackagesAuth,
  type PackageManager,
} from './support.js';

export interface BrainCliOptions {
  /** Pinned CLI version, e.g. `0.14.0`. Never floating. Required unless `fromSource` is set. */
  cliVersion?: string;
  /**
   * Run this local command instead of installing the CLI, e.g. `pnpm brain lint --quiet` in the repository that
   * builds the CLI. The job must already have the toolchain (see `toolchainSteps`; standalone, `BrainLint` adds it).
   * Not combinable with `cliVersion`, `registry`, `package` or `tokenSecret`; `command` is ignored.
   */
  fromSource?: string;
  /**
   * Where the CLI comes from. `'npm'` (default): `@craftvalue/delivery-brain` on npmjs.
   * `'github'`: `@craftvalueorg/delivery-brain` on GitHub Packages, installed with the workflow's `GITHUB_TOKEN`
   * (needs `packages: read`, added by `BrainLint`).
   */
  registry?: 'github' | 'npm';
  /** Package name. Default depends on `registry`. */
  package?: string;
  /** Secret used instead of `GITHUB_TOKEN` to read GitHub Packages. */
  tokenSecret?: string;
  /** Lint command. Default `brain lint`. */
  command?: string;
  /** Named steps run after the lint, e.g. `{ 'Build the brain site': 'pnpm build:brain-site' }`. */
  extraCommands?: Record<string, string>;
  /** Add an `actions/setup-node` step with this Node major. Always added for `registry: 'github'` (registry config). */
  nodeVersion?: number;
}

const DEFAULT_PACKAGE = { npm: '@craftvalue/delivery-brain', github: '@craftvalueorg/delivery-brain' } as const;

/** Steps installing the pinned brain CLI and running the lint (and extra commands). Reusable in any job. */
export function brainCliSteps(scope: Construct, o: BrainCliOptions): StepProps[] {
  if (o.fromSource !== undefined) {
    if (o.cliVersion || o.registry || o.package || o.tokenSecret)
      throw new Error('BrainLint: `fromSource` cannot be combined with cliVersion, registry, package or tokenSecret');
    const local: StepProps[] = [];
    if (o.nodeVersion !== undefined)
      local.push({ uses: 'actions/setup-node@v7', with: { 'node-version': o.nodeVersion } });
    local.push({ name: 'brain lint', run: o.fromSource });
    for (const [name, run] of Object.entries(o.extraCommands ?? {})) local.push({ name, run });
    return local;
  }
  if (!o.cliVersion) throw new Error('BrainLint: `cliVersion` is required unless `fromSource` is set');
  const registry = o.registry ?? 'npm';
  const pkg = shellSafe(o.package ?? DEFAULT_PACKAGE[registry], 'package');
  const version = shellSafe(o.cliVersion, 'cliVersion');
  if (version === 'latest' || !/^\d/.test(version)) throw new Error('BrainLint: cliVersion must be a pinned version');
  const steps: StepProps[] = [];
  let env: Record<string, string> | undefined;
  if (registry === 'github' || o.nodeVersion !== undefined) {
    const w: Record<string, unknown> = { 'node-version': o.nodeVersion ?? 22 };
    if (registry === 'github') {
      w['registry-url'] = 'https://npm.pkg.github.com';
      if (pkg.startsWith('@')) w.scope = pkg.slice(0, pkg.indexOf('/'));
    }
    steps.push({ uses: 'actions/setup-node@v7', with: w });
  }
  if (registry === 'github')
    env = {
      NODE_AUTH_TOKEN: o.tokenSecret
        ? secret(scope, o.tokenSecret, { description: 'token to read the brain CLI from GitHub Packages' })
        : '${{ secrets.GITHUB_TOKEN }}',
    };
  steps.push({ name: 'Install brain CLI', run: `npm install --global ${pkg}@${version}`, env });
  steps.push({ name: 'brain lint', run: o.command ?? 'brain lint' });
  for (const [name, run] of Object.entries(o.extraCommands ?? {})) steps.push({ name, run });
  return steps;
}

export interface BrainLintProps extends BrainCliOptions {
  /** Append the steps to this job instead of creating a workflow (e.g. `NodeCi.job`). */
  job?: Job;
  /** Workflow name when standalone. Default `Brain`. */
  name?: string;
  /** Push branches when standalone (pull requests always run). Default `['main']`. */
  branches?: string[];
  /** Job timeout when standalone. Default 10. */
  timeoutMinutes?: number;
  /** Standalone with `fromSource` only: package manager of the toolchain. Default `pnpm`. */
  packageManager?: PackageManager;
  /** Standalone with `fromSource` only: private package registry for the install; adds `packages: read`. */
  registryAuth?: GitHubPackagesAuth;
}

/**
 * Delivery brain lint. Standalone it is workflow `brain` with a single `lint` job; with `job` it appends the
 * steps to an existing job. With `registry: 'github'` the job gets `packages: read`.
 */
export class BrainLint extends Construct {
  /** The standalone workflow (undefined with `job`). */
  readonly workflow?: Workflow;
  /** The job the steps live in. */
  readonly job: Job;

  constructor(scope: Construct, id: string, props: BrainLintProps) {
    super(scope, id);
    const github = props.registry === 'github';
    if (props.job) {
      this.job = props.job;
    } else {
      this.workflow = new Workflow(this, 'brain', {
        name: props.name ?? 'Brain',
        on: { push: { branches: props.branches ?? ['main'] }, pullRequest: {} },
        permissions: { contents: 'read' },
        concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', cancelInProgress: true },
      });
      this.job = this.workflow.addJob('lint', { runsOn: 'ubuntu-latest', timeoutMinutes: props.timeoutMinutes ?? 10 });
      if (props.fromSource === undefined) this.job.addStep({ uses: 'actions/checkout@v7' });
      else {
        // A local command needs the repository's toolchain (installed dependencies), not just a checkout.
        const auth = props.registryAuth ? resolveRegistryAuth(this, props.registryAuth) : undefined;
        if (auth) grantPermission(this.job, 'packages', 'read');
        for (const s of toolchainSteps({
          packageManager: props.packageManager,
          nodeVersion: props.nodeVersion,
          auth,
        }))
          this.job.addStep(s);
      }
    }
    if (github) grantPermission(this.job, 'packages', 'read');
    const {
      job: _job,
      name: _n,
      branches: _b,
      timeoutMinutes: _t,
      packageManager: _p,
      registryAuth: _r,
      ...cli
    } = props;
    // Standalone: `fromSource` already got Node from the toolchain; the CLI install gets its own setup-node.
    const standaloneCli = !props.job && props.fromSource === undefined;
    const opts = standaloneCli ? { nodeVersion: 22, ...cli } : props.job ? cli : { ...cli, nodeVersion: undefined };
    for (const s of brainCliSteps(this, opts)) this.job.addStep(s);
  }
}
