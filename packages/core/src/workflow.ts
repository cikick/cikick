import { Construct, IConstruct } from 'constructs';
import { ActionRef } from './action-ref.js';
import { OverrideOp, applyOverrides, kebab, prune, snake } from './overrides.js';

const WORKFLOW = Symbol.for('@cikick/core.Workflow');
const JOB = Symbol.for('@cikick/core.Job');
const STEP = Symbol.for('@cikick/core.Step');
const hasBrand = (x: unknown, b: symbol) => typeof x === 'object' && x !== null && (x as any)[b] === true;

export type PermissionLevel = 'read' | 'write' | 'none';
export type Permissions = 'read-all' | 'write-all' | Record<string, PermissionLevel>;

export interface PushTrigger {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
}
export interface PullRequestTrigger {
  branches?: string[];
  branchesIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
  types?: string[];
}
export interface WorkflowInput {
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  type?: 'string' | 'number' | 'boolean' | 'choice' | 'environment';
  options?: string[];
}
export interface WorkflowCallTrigger {
  inputs?: Record<string, WorkflowInput>;
  secrets?: Record<string, { description?: string; required?: boolean }>;
  outputs?: Record<string, { description?: string; value: string }>;
}
export interface WorkflowTriggers {
  push?: PushTrigger | null;
  pullRequest?: PullRequestTrigger | null;
  pullRequestTarget?: PullRequestTrigger | null;
  workflowDispatch?: { inputs?: Record<string, WorkflowInput> } | null;
  schedule?: { cron: string }[];
  workflowCall?: WorkflowCallTrigger | null;
  workflowRun?: { workflows: string[]; types?: string[]; branches?: string[] };
  /** Any other event, keyed by camelCase or snake_case event name. */
  [event: string]: unknown;
}

export interface Concurrency {
  group: string;
  cancelInProgress?: boolean | string;
}

export interface WorkflowProps {
  name?: string;
  runName?: string;
  on: WorkflowTriggers | string | string[];
  permissions?: Permissions;
  concurrency?: string | Concurrency;
  env?: Record<string, string>;
  defaults?: Record<string, unknown>;
}

export interface StepProps {
  id?: string;
  name?: string;
  uses?: ActionRef | string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
  workingDirectory?: string;
  shell?: string;
  timeoutMinutes?: number;
  continueOnError?: boolean;
}

export interface Strategy {
  matrix?: Record<string, unknown> | string;
  failFast?: boolean;
  maxParallel?: number;
}

export interface JobProps {
  name?: string;
  runsOn?: string | string[] | Record<string, unknown>;
  permissions?: Permissions;
  needs?: string | Job | (string | Job)[];
  if?: string;
  env?: Record<string, string>;
  timeoutMinutes?: number;
  continueOnError?: boolean;
  strategy?: Strategy;
  environment?: string | { name: string; url?: string };
  outputs?: Record<string, string>;
  concurrency?: string | Concurrency;
  defaults?: Record<string, unknown>;
  services?: Record<string, unknown>;
  container?: string | Record<string, unknown>;
  /** Reusable workflow call: `owner/repo/.github/workflows/x.yml@ref` or `./.github/workflows/x.yml`. */
  uses?: ActionRef | string;
  with?: Record<string, unknown>;
  secrets?: Record<string, string> | 'inherit';
}

/** Marker joining a uses value and its ref comment before YAML post-processing. */
const COMMENT_MARK = ' ~~';

function normalizeUses(u: ActionRef | string | undefined): ActionRef | string | undefined {
  if (typeof u !== 'string') return u;
  return ActionRef.tryParse(u) ?? u;
}

function renderUses(u: ActionRef | string, annotate: boolean): string {
  if (typeof u === 'string') return u;
  const s = u.toString();
  return annotate && u.sha && u.ref !== u.sha ? `${s}${COMMENT_MARK}${u.ref}` : s;
}

function renderPermissions(p: Permissions | undefined): unknown {
  if (p === undefined || typeof p === 'string') return p;
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [kebab(k), v]));
}

function renderConcurrency(c: string | Concurrency | undefined): unknown {
  if (c === undefined || typeof c === 'string') return c;
  return { group: c.group, 'cancel-in-progress': c.cancelInProgress };
}

function renderOn(on: WorkflowProps['on']): unknown {
  if (typeof on === 'string' || Array.isArray(on)) return on;
  const out: Record<string, unknown> = {};
  for (const [event, cfg] of Object.entries(on)) {
    if (cfg === undefined) continue;
    if (cfg === null) out[snake(event)] = {};
    else if (typeof cfg === 'object' && !Array.isArray(cfg)) {
      out[snake(event)] = Object.fromEntries(Object.entries(cfg).map(([k, v]) => [kebab(k), v]));
    } else out[snake(event)] = cfg;
  }
  return out;
}

export class Step extends Construct {
  static isStep(x: unknown): x is Step {
    return hasBrand(x, STEP);
  }
  readonly [STEP] = true;
  readonly props: StepProps;

  constructor(scope: Construct, id: string, props: StepProps) {
    super(scope, id);
    this.props = { ...props, uses: normalizeUses(props.uses) };
  }

  /** ActionRef if this step uses a remote action. */
  get actionRef(): ActionRef | undefined {
    return this.props.uses instanceof ActionRef ? this.props.uses : undefined;
  }

  render(annotate = false): Record<string, unknown> {
    const p = this.props;
    return prune({
      name: p.name,
      id: p.id,
      if: p.if,
      uses: p.uses === undefined ? undefined : renderUses(p.uses, annotate),
      with: p.with,
      env: p.env,
      run: p.run,
      'working-directory': p.workingDirectory,
      shell: p.shell,
      'timeout-minutes': p.timeoutMinutes,
      'continue-on-error': p.continueOnError,
    });
  }
}

export class Job extends Construct {
  static isJob(x: unknown): x is Job {
    return hasBrand(x, JOB);
  }
  readonly [JOB] = true;
  readonly props: JobProps;
  private readonly overrides: OverrideOp[] = [];
  private stepCount = 0;

  constructor(scope: Construct, id: string, props: JobProps = {}) {
    super(scope, id);
    this.props = { ...props, uses: normalizeUses(props.uses) };
  }

  get permissions(): Permissions | undefined {
    return this.props.permissions;
  }
  set permissions(p: Permissions | undefined) {
    this.props.permissions = p;
  }
  get needs(): JobProps['needs'] {
    return this.props.needs;
  }
  set needs(n: JobProps['needs']) {
    this.props.needs = n;
  }

  get steps(): Step[] {
    return this.node.children.filter(Step.isStep);
  }

  addStep(step: StepProps): Step {
    return new Step(this, `step-${this.stepCount++}`, step);
  }

  /** Remote action / reusable workflow refs used by this job. */
  actionRefs(): ActionRef[] {
    const refs: ActionRef[] = [];
    if (this.props.uses instanceof ActionRef) refs.push(this.props.uses);
    for (const s of this.steps) if (s.actionRef) refs.push(s.actionRef);
    return refs;
  }

  addOverride(path: string, value: unknown): void {
    this.overrides.push({ op: 'set', path, value });
  }
  addDeletionOverride(path: string): void {
    this.overrides.push({ op: 'delete', path });
  }

  render(annotate = false): Record<string, unknown> {
    const p = this.props;
    const needs =
      p.needs === undefined
        ? undefined
        : (Array.isArray(p.needs) ? p.needs : [p.needs]).map((n) => (typeof n === 'string' ? n : n.node.id));
    const strat = p.strategy && prune({ matrix: p.strategy.matrix, 'fail-fast': p.strategy.failFast, 'max-parallel': p.strategy.maxParallel });
    const obj = prune({
      name: p.name,
      if: p.if,
      needs: needs && needs.length === 1 ? needs[0] : needs,
      'runs-on': p.runsOn,
      permissions: renderPermissions(p.permissions),
      environment: p.environment,
      concurrency: renderConcurrency(p.concurrency),
      outputs: p.outputs,
      env: p.env,
      defaults: p.defaults,
      'timeout-minutes': p.timeoutMinutes,
      'continue-on-error': p.continueOnError,
      strategy: strat,
      services: p.services,
      container: p.container,
      uses: p.uses === undefined ? undefined : renderUses(p.uses, annotate),
      with: p.uses === undefined ? undefined : p.with,
      secrets: p.uses === undefined ? undefined : p.secrets,
      steps: p.uses === undefined ? this.steps.map((s) => s.render(annotate)) : undefined,
    });
    applyOverrides(obj, this.overrides);
    return obj;
  }

  toObject(): Record<string, unknown> {
    return this.render(false);
  }
}

export class Workflow extends Construct {
  static isWorkflow(x: unknown): x is Workflow {
    return hasBrand(x, WORKFLOW);
  }
  readonly [WORKFLOW] = true;
  readonly props: WorkflowProps;
  private readonly overrides: OverrideOp[] = [];

  constructor(scope: Construct, id: string, props: WorkflowProps) {
    super(scope, id);
    this.props = props;
  }

  /** Output path relative to repo root. */
  get filePath(): string {
    return `.github/workflows/${this.node.id}.yml`;
  }

  get jobs(): Job[] {
    return this.node.children.filter(Job.isJob);
  }

  addJob(id: string, props: JobProps = {}): Job {
    return new Job(this, id, props);
  }

  actionRefs(): ActionRef[] {
    return this.jobs.flatMap((j) => j.actionRefs());
  }

  addOverride(path: string, value: unknown): void {
    this.overrides.push({ op: 'set', path, value });
  }
  addDeletionOverride(path: string): void {
    this.overrides.push({ op: 'delete', path });
  }

  /** @internal render with optional ref-comment markers (used by synth). */
  render(annotate = false): Record<string, unknown> {
    const p = this.props;
    const jobs: Record<string, unknown> = {};
    for (const j of this.jobs) jobs[j.node.id] = j.render(annotate);
    const obj = prune({
      name: p.name,
      'run-name': p.runName,
      on: renderOn(p.on),
      permissions: renderPermissions(p.permissions),
      concurrency: renderConcurrency(p.concurrency),
      env: p.env,
      defaults: p.defaults,
      jobs,
    });
    applyOverrides(obj, this.overrides);
    return obj;
  }

  toObject(): Record<string, unknown> {
    return this.render(false);
  }
}

export const REF_COMMENT_MARK = COMMENT_MARK;
export type { IConstruct };
