import { ActionRef, Job, Step, Workflow, type IAspect, type Permissions } from '@cikick/core';
import type { IConstruct } from 'constructs';

export interface ExplicitPermissionsProps {
  /** Permissions applied where none are declared. Default `{ contents: 'read' }`. */
  default?: Permissions;
  /** Where to set them. `workflow` (default) sets workflow-level; `job` sets on every job lacking permissions. */
  level?: 'workflow' | 'job';
}

/** Sets permissions where absent (least privilege by default). */
export class ExplicitPermissions implements IAspect {
  private readonly perms: Permissions;
  private readonly level: 'workflow' | 'job';
  constructor(props: ExplicitPermissionsProps = {}) {
    this.perms = props.default ?? { contents: 'read' };
    this.level = props.level ?? 'workflow';
  }
  private fresh(): Permissions {
    return typeof this.perms === 'string' ? this.perms : { ...this.perms };
  }
  visit(node: IConstruct): void {
    if (this.level === 'workflow' && Workflow.isWorkflow(node) && node.props.permissions === undefined) {
      node.props.permissions = this.fresh();
    } else if (this.level === 'job' && Job.isJob(node) && node.props.permissions === undefined) {
      node.props.permissions = this.fresh();
    }
  }
}

/** Sets `timeout-minutes` on every job (except reusable-workflow calls) that has none. */
export class DefaultTimeout implements IAspect {
  constructor(private readonly minutes: number) {}
  visit(node: IConstruct): void {
    if (Job.isJob(node) && node.props.uses === undefined && node.props.timeoutMinutes === undefined) {
      node.props.timeoutMinutes = this.minutes;
    }
  }
}

export interface HardenRunnerProps {
  egressPolicy?: 'audit' | 'block';
  /** Action ref to use. Default `step-security/harden-runner@v2`. */
  action?: string;
  /** Extra `with` inputs (e.g. `allowed-endpoints`). */
  with?: Record<string, unknown>;
}

/** Prepends step-security/harden-runner to every job that has steps. */
export class HardenRunner implements IAspect {
  private readonly action: string;
  private readonly withInputs: Record<string, unknown>;
  constructor(props: HardenRunnerProps = {}) {
    this.action = props.action ?? 'step-security/harden-runner@v2';
    this.withInputs = { 'egress-policy': props.egressPolicy ?? 'audit', ...props.with };
  }
  visit(node: IConstruct): void {
    if (!Job.isJob(node) || node.props.uses !== undefined) return;
    const steps = node.steps;
    if (steps.length === 0) return;
    const target = ActionRef.of(this.action);
    const isHarden = (s: Step) => s.actionRef?.owner === target.owner && s.actionRef.repo === target.repo;
    if (isHarden(steps[0]!)) return;
    // Constructs cannot be reordered: append a step then shift every step's props down by one.
    const old = steps.map((s) => ({ ...s.props }));
    const added = node.addStep({ name: 'Harden Runner', uses: this.action, with: { ...this.withInputs } });
    const all = [...steps, added];
    const next = [{ ...added.props }, ...old];
    all.forEach((s, i) => {
      for (const k of Object.keys(s.props)) delete (s.props as any)[k];
      Object.assign(s.props, next[i]);
    });
  }
}

export interface ReplaceActionProps {
  /** `owner/repo[/path]@ref` to replace. */
  from: string;
  /** Replacement `owner/repo[/path]@ref`. */
  to: string;
}

/** Replaces one action ref with another (e.g. deprecated actions). */
export class ReplaceAction implements IAspect {
  private readonly from: ActionRef;
  private readonly to: ActionRef;
  constructor(props: ReplaceActionProps) {
    this.from = ActionRef.of(props.from);
    this.to = ActionRef.of(props.to);
  }
  visit(node: IConstruct): void {
    if (!Step.isStep(node) && !Job.isJob(node)) return;
    const u = node.props.uses;
    if (u instanceof ActionRef && u.toSpec() === this.from.toSpec()) {
      node.props.uses = new ActionRef({ owner: this.to.owner, repo: this.to.repo, path: this.to.path, ref: this.to.ref });
    }
  }
}
