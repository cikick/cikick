import {
  Workflow,
  type Job,
  type Permissions,
  type StepProps,
  type WorkflowCallTrigger,
  type WorkflowInput,
  type WorkflowTriggers,
} from '@cikick/core';
import type { PullRequestTrigger, PushTrigger } from '@cikick/core';
import { Construct } from 'constructs';
import { resolveRegistryAuth, toolchainSteps, type GitHubPackagesAuth, type PackageManager } from './support.js';

export interface NodeCiTriggers {
  /** `true` (default): pushes to `branches` (default `['main']`). `false`: none. An object replaces the default. */
  push?: boolean | PushTrigger;
  /** `true` (default): every pull request. `false`: none. An object restricts it. */
  pullRequest?: boolean | PullRequestTrigger;
  /** Make the workflow callable from other workflows (`on: workflow_call`). Default `false`. */
  workflowCall?: boolean | WorkflowCallTrigger;
  /** Allow manual runs (`on: workflow_dispatch`). Default `false`. Needed for a `CloudflareDeploy` with `dispatch` and `into`. */
  workflowDispatch?: boolean | { inputs?: Record<string, WorkflowInput> };
}

export interface NodeCiArtifact {
  /** Artifact name. */
  name: string;
  /** Path(s) to upload, relative to the repository root. */
  path: string;
}

export interface NodeCiJob {
  /** Display name of the job. */
  name?: string;
  /** Directory the commands run in (install stays at the repository root). */
  workingDirectory?: string;
  /** Steps run in order after install, each as a named step. */
  commands: Record<string, string>;
  /** Job environment, merged over the top-level `env`. */
  env?: Record<string, string>;
  /** Uploaded with `actions/upload-artifact` after the commands. */
  artifacts?: NodeCiArtifact[];
  /** Job condition (`if:`), e.g. `github.event_name == 'pull_request'`. */
  if?: string;
  /** Job permissions; replace the workflow's permissions for this job. */
  permissions?: Permissions;
}

export interface NodeCiProps {
  /** Workflow name (what branch protection sees as the check prefix). Default `CI`. The file is always `ci.yml`. */
  name?: string;
  /** Node.js major version. Default 22. */
  nodeVersion?: number;
  /** Default `pnpm` (uses `pnpm/action-setup`, version from `packageManager` in package.json). */
  packageManager?: PackageManager;
  /** Branches whose pushes run CI (pull requests always do). Default `['main']`. Ignored when `triggers.push` is an object. */
  branches?: string[];
  /** Workflow triggers. Default: push to `branches` and pull requests. */
  triggers?: NodeCiTriggers;
  /** Commands run in order after install, each as a named step. Default: build, test. Not combinable with `jobs`. */
  commands?: Record<string, string>;
  /**
   * Several parallel jobs instead of the single `check` job, keyed by job id. Not combinable with `commands` or
   * `extraSteps`. `cikickCheck` defaults to `false` here; when set it runs in the first job.
   */
  jobs?: Record<string, NodeCiJob>;
  /** Directory the commands run in (install stays at the repository root). Per-job `workingDirectory` wins. */
  workingDirectory?: string;
  /** Environment for every job. */
  env?: Record<string, string>;
  /** Run `cikick check` last: `true` (default) runs `npx cikick check`, a string overrides the command, `false` skips. */
  cikickCheck?: boolean | string;
  /** Job timeout. Default 15. */
  timeoutMinutes?: number;
  /** Extra steps appended at the end of the job. */
  extraSteps?: StepProps[];
  /**
   * Cancel superseded runs of the same ref. `true` (default), `false`, or `'pull-request-only'` (cancel only runs
   * triggered by `pull_request`, so pushes to the default branch always finish).
   */
  cancelInProgress?: boolean | 'pull-request-only';
  /** Workflow permissions added to the default `contents: read`. */
  extraPermissions?: Record<string, 'read' | 'write' | 'none'>;
  /** Install private packages (GitHub Packages): `setup-node` registry config, token via `NODE_AUTH_TOKEN`. Adds `packages: read`. */
  registryAuth?: GitHubPackagesAuth;
  /** `actions/checkout` `fetch-depth` (`0` = full history). Default: the action's (1). */
  fetchDepth?: number;
  /** Name of the install step. Default `Install`. */
  installStepName?: string;
}

/**
 * Node.js CI workflow `ci`: checkout, setup, install, your commands, then `cikick check`.
 * One `check` job by default, or parallel jobs with `jobs`.
 */
export class NodeCi extends Construct {
  readonly workflow: Workflow;
  /** Escape hatch: the `check` job (the first job when `jobs` is set). */
  readonly job: Job;
  /** Every job by id (`{ check }` without `jobs`). */
  readonly jobs: Record<string, Job> = {};

  constructor(scope: Construct, id: string, props: NodeCiProps = {}) {
    super(scope, id);
    if (props.jobs && (props.commands || props.extraSteps))
      throw new Error('NodeCi: `jobs` cannot be combined with `commands` or `extraSteps`; put them in each job');
    const pm = props.packageManager ?? 'pnpm';
    const run = (script: string) => (pm === 'pnpm' ? `pnpm ${script}` : `npm run ${script}`);

    const t = props.triggers ?? {};
    const on: WorkflowTriggers = {};
    const push = t.push ?? true;
    if (push) on.push = push === true ? { branches: props.branches ?? ['main'] } : push;
    const pr = t.pullRequest ?? true;
    if (pr) on.pullRequest = pr === true ? {} : pr;
    if (t.workflowCall) on.workflowCall = t.workflowCall === true ? {} : t.workflowCall;
    if (t.workflowDispatch) on.workflowDispatch = t.workflowDispatch === true ? {} : t.workflowDispatch;
    if (Object.keys(on).length === 0) throw new Error('NodeCi: at least one trigger must be enabled');

    const auth = props.registryAuth ? resolveRegistryAuth(this, props.registryAuth) : undefined;
    const permissions: Permissions = {
      contents: 'read',
      ...(props.registryAuth ? { packages: 'read' as const } : {}),
      ...props.extraPermissions,
    };
    const cancel = props.cancelInProgress ?? true;
    this.workflow = new Workflow(this, 'ci', {
      name: props.name ?? 'CI',
      on,
      permissions,
      concurrency: {
        group: '${{ github.workflow }}-${{ github.ref }}',
        cancelInProgress: cancel === 'pull-request-only' ? "${{ github.event_name == 'pull_request' }}" : cancel,
      },
    });

    const defaultCommands = { Build: run('build'), Test: pm === 'pnpm' ? 'pnpm test' : 'npm test' };
    const specs: Record<string, NodeCiJob> = props.jobs ?? {
      check: { commands: props.commands ?? defaultCommands },
    };
    const check = props.cikickCheck ?? (props.jobs ? false : true);
    let first: Job | undefined;
    for (const [jobId, spec] of Object.entries(specs)) {
      const env = { ...props.env, ...spec.env };
      const job = this.workflow.addJob(jobId, {
        name: spec.name,
        runsOn: 'ubuntu-latest',
        timeoutMinutes: props.timeoutMinutes ?? 15,
        if: spec.if,
        permissions: spec.permissions,
        env: Object.keys(env).length ? env : undefined,
      });
      this.jobs[jobId] = job;
      const isFirst = (first ??= job) === job;
      for (const s of toolchainSteps({
        packageManager: pm,
        nodeVersion: props.nodeVersion ?? 22,
        fetchDepth: props.fetchDepth,
        auth,
        installStepName: props.installStepName,
      }))
        job.addStep(s);
      const cwd = spec.workingDirectory ?? props.workingDirectory;
      for (const [name, cmd] of Object.entries(spec.commands)) job.addStep({ name, run: cmd, workingDirectory: cwd });
      if (check !== false && isFirst)
        job.addStep({ name: 'cikick check', run: check === true ? 'npx cikick check' : check, workingDirectory: cwd });
      for (const a of spec.artifacts ?? [])
        job.addStep({ uses: 'actions/upload-artifact@v7', with: { name: a.name, path: a.path } });
      if (!props.jobs) for (const s of props.extraSteps ?? []) job.addStep(s);
    }
    this.job = first!;
  }
}
