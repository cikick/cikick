import {
  ActionRef,
  Workflow,
  isSha,
  type Check,
  type CheckContext,
  type Concurrency,
  type Finding,
  type Job,
  type Severity,
} from '@cikick/core';

const wfPath = (wf: Workflow) => wf.filePath;
const workflows = (ctx: CheckContext) => ctx.app.node.findAll().filter(Workflow.isWorkflow);

/** Error on any action ref that is not resolved to a commit sha after synth (or docker image without digest). */
export const requirePinnedActions: Check = {
  id: 'require-pinned-actions',
  severity: 'error',
  run(ctx) {
    const out: Finding[] = [];
    for (const wf of workflows(ctx)) {
      const items: { where: string; uses: unknown }[] = [];
      for (const job of wf.jobs) {
        if (job.props.uses !== undefined) items.push({ where: `${job.node.id}`, uses: job.props.uses });
        for (const s of job.steps)
          if (s.props.uses !== undefined) items.push({ where: `${job.node.id}`, uses: s.props.uses });
      }
      for (const { where, uses } of items) {
        let msg: string | undefined;
        if (uses instanceof ActionRef) {
          if (!uses.sha || !isSha(uses.sha)) msg = `${uses.toSpec()} is not pinned to a commit sha`;
        } else if (typeof uses === 'string' && uses.startsWith('docker://') && !uses.includes('@sha256:')) {
          msg = `${uses} is not pinned to an image digest`;
        } else if (typeof uses === 'string' && !uses.startsWith('./') && !uses.startsWith('docker://')) {
          msg = `${uses} is not a valid pinned action reference`;
        }
        if (msg)
          out.push({
            checkId: 'require-pinned-actions',
            severity: 'error',
            message: `job "${where}": ${msg}`,
            path: wfPath(wf),
          });
      }
    }
    return out;
  },
};

/** Error when neither the workflow nor every job declares permissions. */
export const requireExplicitPermissions: Check = {
  id: 'require-explicit-permissions',
  severity: 'error',
  run(ctx) {
    const out: Finding[] = [];
    for (const wf of workflows(ctx)) {
      if (wf.props.permissions !== undefined) continue;
      for (const job of wf.jobs) {
        if (job.props.permissions === undefined) {
          out.push({
            checkId: 'require-explicit-permissions',
            severity: 'error',
            message: `job "${job.node.id}" has no explicit permissions (and workflow declares none)`,
            path: wfPath(wf),
          });
        }
      }
    }
    return out;
  },
};

function triggersPullRequestTarget(wf: Workflow): boolean {
  const on = wf.props.on;
  if (typeof on === 'string') return on === 'pull_request_target';
  if (Array.isArray(on)) return on.includes('pull_request_target');
  return ['pullRequestTarget', 'pull_request_target'].some((k) => (on as Record<string, unknown>)[k] !== undefined);
}

/** Error: pull_request_target workflows must not check out untrusted PR head code. */
export const noPullRequestTargetCheckout: Check = {
  id: 'no-pull-request-target-checkout',
  severity: 'error',
  run(ctx) {
    const out: Finding[] = [];
    for (const wf of workflows(ctx)) {
      if (!triggersPullRequestTarget(wf)) continue;
      for (const job of wf.jobs) {
        for (const s of job.steps) {
          const ref = s.actionRef;
          if (!ref || ref.owner !== 'actions' || ref.repo !== 'checkout') continue;
          const w = s.props.with ?? {};
          const r = [w.ref, w.repository]
            .filter((v) => v !== undefined)
            .map(String)
            .join(' ');
          if (/head|github\.event\.pull_request|github\.head_ref|refs\/pull\//i.test(r)) {
            out.push({
              checkId: 'no-pull-request-target-checkout',
              severity: 'error',
              message: `job "${job.node.id}" checks out PR head code in a pull_request_target workflow (privileged context)`,
              path: wfPath(wf),
            });
          }
        }
      }
    }
    return out;
  },
};

const INJECTABLE = new RegExp(
  [
    // Contexts an outside contributor controls: branch names, issue/PR/comment text, commit metadata.
    'github\\.(head_ref|base_ref|event\\.(inputs\\.[\\w-]+|issue\\.(title|body)|pull_request\\.(title|body|head\\.(ref|label|repo\\.default_branch))|comment\\.body|review\\.body|review_comment\\.body|discussion\\.(title|body)|pages\\.[^}\\s]*page_name|commits\\[?[^}\\s]*message|head_commit\\.(message|author\\.(name|email))|[^}\\s]*\\.(title|body|head_ref|label|message)))',
    // Free-form workflow_dispatch / workflow_call inputs.
    '(?<![\\w.])inputs\\.[\\w-]+',
  ].join('|'),
);

/**
 * Warn on attacker-controlled expressions interpolated directly into `run:` scripts: PR/issue text, branch names
 * (`github.head_ref`, `github.base_ref`) and workflow inputs (`inputs.*`, `github.event.inputs.*`).
 */
export const noScriptInjection: Check = {
  id: 'no-script-injection',
  severity: 'warn',
  run(ctx) {
    const out: Finding[] = [];
    for (const wf of workflows(ctx)) {
      for (const job of wf.jobs) {
        for (const s of job.steps) {
          const run = s.props.run;
          if (!run) continue;
          for (const m of run.matchAll(/\$\{\{([^}]*)\}\}/g)) {
            const hit = INJECTABLE.exec(m[1]!);
            if (hit) {
              out.push({
                checkId: 'no-script-injection',
                severity: 'warn',
                message: `job "${job.node.id}": \`${hit[0]}\` is interpolated into a run script; pass it through env instead`,
                path: wfPath(wf),
              });
            }
          }
        }
      }
    }
    return out;
  },
};

/** Warn on jobs without timeout-minutes. */
export const requireTimeout: Check = {
  id: 'require-timeout',
  severity: 'warn',
  run(ctx) {
    const out: Finding[] = [];
    for (const wf of workflows(ctx)) {
      for (const job of wf.jobs) {
        if (job.props.uses === undefined && job.props.timeoutMinutes === undefined) {
          out.push({
            checkId: 'require-timeout',
            severity: 'warn',
            message: `job "${job.node.id}" has no timeout-minutes`,
            path: wfPath(wf),
          });
        }
      }
    }
    return out;
  },
};

export interface DeprecatedActionProps {
  /** `owner/repo[/path]` */
  action: string;
  /** Refs with a major version below this (e.g. `v4`) are flagged. */
  below: string;
  /** ISO date after which the warning becomes an error. */
  enforceAfter?: string;
  severity?: Severity;
}

const major = (ref: string): number | undefined => {
  const m = /^v?(\d+)(?:[.-]|$)/.exec(ref);
  return m ? Number(m[1]) : undefined;
};

export function deprecatedAction(props: DeprecatedActionProps): Check {
  const id = `deprecated-action:${props.action}`;
  const below = major(props.below);
  if (below === undefined) throw new Error(`deprecatedAction: cannot parse version "${props.below}"`);
  const severity = props.severity ?? 'warn';
  return {
    id,
    severity,
    enforceAfter: props.enforceAfter,
    run(ctx) {
      const out: Finding[] = [];
      for (const wf of workflows(ctx)) {
        const seen = new Set<string>();
        for (const job of wf.jobs) {
          for (const r of job.actionRefs()) {
            if (r.target !== props.action) continue;
            const v = major(r.ref);
            if (v === undefined || v >= below || seen.has(r.ref)) continue;
            seen.add(r.ref);
            out.push({
              checkId: id,
              severity,
              message: `${r.toSpec()} is deprecated; use ${props.action}@${props.below} or newer`,
              path: wfPath(wf),
            });
          }
        }
      }
      return out;
    },
  };
}

export interface FileContainsProps {
  id?: string;
  path: string;
  /** The file must match this regexp / contain this string / satisfy this predicate. */
  pattern: RegExp | string | ((content: string) => boolean);
  message: string;
  severity?: Severity;
  enforceAfter?: string;
  /** Also report when the file is missing. Default false. */
  required?: boolean;
}

/** Generic repo-file nudge: report when `path` exists (or is required) but does not match `pattern`. */
export function fileContains(props: FileContainsProps): Check {
  const id = props.id ?? `file-contains:${props.path}`;
  const severity = props.severity ?? 'warn';
  return {
    id,
    severity,
    enforceAfter: props.enforceAfter,
    run(ctx) {
      const content = ctx.readFile(props.path);
      if (content === undefined) {
        return props.required ? [{ checkId: id, severity, message: props.message, path: props.path }] : [];
      }
      const p = props.pattern;
      const ok =
        typeof p === 'function'
          ? p(content)
          : typeof p === 'string'
            ? content.includes(p)
            : new RegExp(p.source, p.flags.replace('g', '')).test(content);
      return ok ? [] : [{ checkId: id, severity, message: props.message, path: props.path }];
    },
  };
}

const DEPLOY_COMMAND = /\bwrangler\b[^\n]*\b(deploy|publish|d1\s+migrations\s+apply)\b/;
const PR_ONLY_CANCEL = /^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}$/;

/** Heuristic: a job that targets an environment, runs wrangler deploy/migrations or uses cloudflare/wrangler-action. */
function isDeployJob(job: Job): boolean {
  if (job.props.environment !== undefined) return true;
  return job.steps.some((s) => {
    const ref = s.actionRef;
    if (ref && ref.owner === 'cloudflare' && ref.repo === 'wrangler-action') return true;
    return s.props.run !== undefined && DEPLOY_COMMAND.test(s.props.run);
  });
}

/** `cancel-in-progress` is risky unless it is off or limited to pull requests (`github.event_name == 'pull_request'`). */
function cancelsInProgress(c: string | Concurrency | undefined): boolean {
  if (c === undefined || typeof c === 'string') return false;
  const v = c.cancelInProgress;
  if (v === undefined || v === false) return false;
  if (typeof v === 'string') return !PR_ONLY_CANCEL.test(v.trim()) && v.trim() !== 'false';
  return true;
}

/**
 * Warn when a deploy job (environment, `wrangler deploy` / `pages deploy` / `d1 migrations apply`, or
 * `cloudflare/wrangler-action`) can be cancelled mid-flight by `concurrency.cancel-in-progress`, at job or workflow
 * level. Cancelling a deploy half way leaves migrations and code out of step. `false`, or an expression limited to
 * `github.event_name == 'pull_request'`, is accepted.
 */
export const noCancelInProgressDeploy: Check = {
  id: 'no-cancel-in-progress-deploy',
  severity: 'warn',
  run(ctx) {
    const out: Finding[] = [];
    for (const wf of workflows(ctx)) {
      for (const job of wf.jobs) {
        if (!isDeployJob(job)) continue;
        const level = cancelsInProgress(job.props.concurrency)
          ? 'job'
          : cancelsInProgress(wf.props.concurrency)
            ? 'workflow'
            : undefined;
        if (level)
          out.push({
            checkId: 'no-cancel-in-progress-deploy',
            severity: 'warn',
            message: `deploy job "${job.node.id}" can be cancelled mid-flight: ${level}-level concurrency sets cancel-in-progress; use \`cancel-in-progress: false\``,
            path: wfPath(wf),
          });
      }
    }
    return out;
  },
};
