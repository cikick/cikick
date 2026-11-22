import {
  Workflow,
  secret,
  type Job,
  type Permissions,
  type SecretScope,
  type StepProps,
  type WorkflowTriggers,
} from '@cikick/core';
import { Construct } from 'constructs';
import {
  resolveRegistryAuth,
  shellSafe,
  toolchainSteps,
  type GitHubPackagesAuth,
  type PackageManager,
} from './support.js';

export interface CloudflareD1Migrations {
  /** D1 database name; `wrangler d1 migrations apply <database> --remote` runs before the deploy. */
  database: string;
  /** `--config` path, when the wrangler config is not in the working directory. */
  configPath?: string;
}

interface TargetBase {
  /** Job id. Default `deploy` for a single target, else `deploy-<kind>` (suffixed `-2`, ... when repeated). */
  id?: string;
  /** Job display name. */
  name?: string;
  /** Directory the build and deploy steps run in (install stays at the repository root). */
  workingDirectory?: string;
  /** pnpm workspace filter: wrangler runs as `pnpm --filter <filter> exec wrangler ...`. */
  filter?: string;
  /** Build command, run before the deploy as step `Build`. */
  build?: string;
  /** Extra job environment for this target. */
  env?: Record<string, string>;
  /** Steps run after install and `preSteps`, before `prebuild`/`build` (e.g. download an artifact). */
  preSteps?: StepProps[];
  /** Run only after the previous target's job (`needs`). */
  dependsOnPreviousTarget?: boolean;
  /** Account id for this target, overriding `secrets.accountId` (e.g. a second Cloudflare account). */
  accountId?: CloudflareAccountId;
}

export interface CloudflareWorkerTarget extends TargetBase {
  kind: 'worker';
  /** Deploy command. Default `<pm> exec wrangler deploy` (`npx wrangler deploy` with npm). */
  run?: string;
  /** Apply D1 migrations first. */
  d1Migrations?: CloudflareD1Migrations;
}

export interface CloudflarePagesTarget extends TargetBase {
  kind: 'pages';
  /** Directory of built assets, `wrangler pages deploy <directory>`. Omit when the wrangler config sets `pages_build_output_dir`. */
  directory?: string;
  /** `--project-name`. Omit to use the wrangler config. */
  project?: string;
}

export type CloudflareTarget = CloudflareWorkerTarget | CloudflarePagesTarget;

export type CloudflareAccountId = { secret: string; scope?: SecretScope } | { variable: string } | false;

export type CloudflareGate =
  /** Deploy after another workflow succeeds on `branch` (`on: workflow_run`); checks out the tested commit. */
  | { workflowRun: string | string[] }
  /** Call a reusable workflow (`./.github/workflows/<file>`, which needs `on: workflow_call`) first. */
  | {
      workflow: string;
      permissions?: Permissions;
      secrets?: 'inherit';
      /** Job id of the call job. Default `gate`; e.g. `check` to keep an existing required check name. */
      id?: string;
      /** Condition of the call job. Default: none (the `into` guard when `into` is set). */
      if?: string;
      /**
       * The workflow also runs on `workflow_run` (add the trigger with `extraTriggers.workflowRun`): the gate is
       * skipped for those events and the deploy proceeds only when the triggering run succeeded. On `push`
       * (or dispatch) the gate must pass, as usual.
       */
      skipUnlessWorkflowRunSucceeded?: boolean;
    }
  /** `needs` these jobs. They must belong to the workflow passed as `into`. */
  | { jobs: Job[] };

/** Step with its own environment, e.g. `{ run: 'pnpm build:shared', env: { CI: '1' } }`. */
export type CloudflarePrebuildStep = string | { run: string; env?: Record<string, string>; workingDirectory?: string };

export interface CloudflareDeploySecrets {
  /** Secret holding the API token. Default `CLOUDFLARE_API_TOKEN`. */
  apiToken?: string | { secret: string; scope?: SecretScope };
  /**
   * Account id, exported as `CLOUDFLARE_ACCOUNT_ID`. `{ variable }` reads `vars.<name>`, `{ secret, scope? }` a
   * secret, `false` omits it. Default `{ variable: 'CLOUDFLARE_ACCOUNT_ID' }`. Targets can override it.
   */
  accountId?: CloudflareAccountId;
  /** Default scope recorded for the declared secrets. Default `repo` (`env` when the secret lives in `environment`). */
  scope?: SecretScope;
}

export interface CloudflareDeployProps {
  /** Workflow name. Default `deploy`. */
  name?: string;
  /** Workflow file id (`.github/workflows/<file>.yml`). Default `deploy`. Ignored with `into`. */
  file?: string;
  /** Add the deploy jobs to this existing workflow (e.g. `NodeCi.workflow`) instead of creating one. */
  into?: Workflow;
  /** Branch deployed from. Default `main`. */
  branch?: string;
  /**
   * Also allow manual runs (`workflow_dispatch`). Default false. With `into`, the target workflow must itself have
   * the trigger (`NodeCi` `triggers.workflowDispatch`); this only widens the guard.
   */
  dispatch?: boolean;
  /**
   * Condition added to the deploy jobs with `into`. Default `github.ref == 'refs/heads/<branch>' && github.event_name
   * == 'push'` (plus `workflow_dispatch` with `dispatch`), so they never run on pull requests. A string replaces it,
   * `false` adds none.
   */
  if?: string | false;
  /** Only pushes touching these paths deploy. Not allowed with a `workflowRun` gate. */
  paths?: string[];
  /** GitHub environment of the deploy jobs. */
  environment?: string;
  /** What must pass before deploying. Without a gate, deploys on push to `branch`. */
  gate?: CloudflareGate;
  nodeVersion?: number;
  packageManager?: PackageManager;
  /** Named steps run in every target job after install, before the target's own steps (e.g. build shared packages). */
  prebuild?: Record<string, CloudflarePrebuildStep>;
  /** Private package registry for the install (same shape as `NodeCi`); adds `packages: read`. */
  registryAuth?: GitHubPackagesAuth;
  /** Arbitrary steps run after install, before `prebuild` (e.g. fetch published data). */
  preSteps?: StepProps[];
  targets: CloudflareTarget[];
  secrets?: CloudflareDeploySecrets;
  /** Concurrency group. Default `deploy-<environment ?? 'production'>`. Deploys never cancel each other. */
  concurrency?: { group?: string };
  /** Job permissions. Default `{ contents: 'read' }`. */
  permissions?: Permissions;
  /** Extra triggers merged into `on` (own workflow only), e.g. `schedule`. */
  extraTriggers?: WorkflowTriggers;
  /** Skip every step (job still succeeds) when the API token secret is empty, e.g. in forks or unconfigured repos. */
  skipWhenSecretMissing?: boolean;
  /** Job timeout. Default 15. */
  timeoutMinutes?: number;
}

const CONFIG_ID = 'cloudflare-config';
const CONFIGURED = `steps.${CONFIG_ID}.outputs.configured == 'true'`;

/**
 * Deploys to Cloudflare with wrangler: Workers (optionally applying D1 migrations first) and Pages, one job per
 * target. Production deploys never cancel in-flight runs (`cancel-in-progress: false`).
 */
export class CloudflareDeploy extends Construct {
  readonly workflow: Workflow;
  /** One job per target, in order. */
  readonly jobs: Job[] = [];
  /** The reusable-workflow call job, with a `{ workflow }` gate. */
  readonly gateJob?: Job;

  constructor(scope: Construct, id: string, props: CloudflareDeployProps) {
    super(scope, id);
    if (props.targets.length === 0) throw new Error('CloudflareDeploy: at least one target is required');
    const pm = props.packageManager ?? 'pnpm';
    const branch = props.branch ?? 'main';
    const gate = props.gate;
    const runGate = gate && 'workflowRun' in gate ? gate : undefined;
    if (runGate && props.paths) throw new Error('CloudflareDeploy: `paths` cannot be combined with a workflowRun gate');
    if (gate && 'jobs' in gate) {
      if (!props.into)
        throw new Error('CloudflareDeploy: a `jobs` gate needs `into`, the workflow that owns those jobs');
      for (const j of gate.jobs)
        if (j.node.scope !== props.into)
          throw new Error(`CloudflareDeploy: gate job "${j.node.id}" is not in \`into\``);
    }
    const skipUnlessRun = !!(gate && 'workflow' in gate && gate.skipUnlessWorkflowRunSucceeded);
    if (skipUnlessRun && props.into)
      throw new Error('CloudflareDeploy: `skipUnlessWorkflowRunSucceeded` needs its own workflow (no `into`)');
    const group = props.concurrency?.group ?? `deploy-${props.environment ?? 'production'}`;

    const dispatchOk = props.dispatch
      ? " && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')"
      : " && github.event_name == 'push'";
    const intoGuard =
      props.into && !runGate && props.if !== false
        ? (props.if ?? `github.ref == 'refs/heads/${shellSafe(branch, 'branch')}'${dispatchOk}`)
        : undefined;
    const auth = props.registryAuth ? resolveRegistryAuth(this, props.registryAuth) : undefined;
    const base = props.permissions ?? { contents: 'read' };
    const permissions: Permissions =
      props.registryAuth && typeof base === 'object' ? { packages: 'read', ...base } : base;

    if (props.into) {
      this.workflow = props.into;
    } else {
      const on: WorkflowTriggers = {};
      if (runGate) {
        const wfs = Array.isArray(runGate.workflowRun) ? runGate.workflowRun : [runGate.workflowRun];
        on.workflowRun = { workflows: wfs, types: ['completed'], branches: [branch] };
      } else {
        on.push = { branches: [branch], ...(props.paths ? { paths: props.paths } : {}) };
      }
      if (props.dispatch) on.workflowDispatch = {};
      Object.assign(on, props.extraTriggers);
      this.workflow = new Workflow(this, props.file ?? 'deploy', {
        name: props.name ?? 'deploy',
        on,
        permissions,
        concurrency: { group, cancelInProgress: false },
      });
    }

    const needsBase: (string | Job)[] = [];
    if (gate && 'workflow' in gate) {
      const file = gate.workflow.startsWith('./') ? gate.workflow : `./.github/workflows/${gate.workflow}`;
      this.gateJob = this.workflow.addJob(gate.id ?? 'gate', {
        uses: file,
        if: gate.if ?? (skipUnlessRun ? "github.event_name != 'workflow_run'" : intoGuard),
        permissions: gate.permissions ?? { contents: 'read' },
        secrets: gate.secrets,
      });
      needsBase.push(this.gateJob);
    }
    if (gate && 'jobs' in gate) needsBase.push(...gate.jobs);

    const sec = props.secrets ?? {};
    const secretOpts = (scope?: SecretScope) =>
      ({
        scope: scope ?? sec.scope ?? (props.environment ? 'env' : 'repo'),
        environment: props.environment,
        provider: 'cloudflare',
      }) as const;
    const token = typeof sec.apiToken === 'object' ? sec.apiToken : { secret: sec.apiToken ?? 'CLOUDFLARE_API_TOKEN' };
    const baseEnv: Record<string, string> = {
      CLOUDFLARE_API_TOKEN: secret(this, token.secret, {
        ...secretOpts(token.scope),
        description: 'Cloudflare API token used by wrangler',
      }),
    };
    const accountEnv = (account: CloudflareAccountId): string | undefined =>
      account === false
        ? undefined
        : 'variable' in account
          ? `\${{ vars.${account.variable} }}`
          : secret(this, account.secret, { ...secretOpts(account.scope), description: 'Cloudflare account id' });
    const defaultAccount = accountEnv(sec.accountId ?? { variable: 'CLOUDFLARE_ACCOUNT_ID' });
    if (defaultAccount !== undefined) baseEnv.CLOUDFLARE_ACCOUNT_ID = defaultAccount;

    const counts = new Map<string, number>();
    props.targets.forEach((t, i) => {
      const n = (counts.get(t.kind) ?? 0) + 1;
      counts.set(t.kind, n);
      const jobId = t.id ?? (props.targets.length === 1 ? 'deploy' : `deploy-${t.kind}${n > 1 ? `-${n}` : ''}`);
      const needs = [...needsBase];
      if (t.dependsOnPreviousTarget && i > 0) needs.push(this.jobs[i - 1]!);
      const ifParts: string[] = [];
      if (runGate)
        ifParts.push("github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'");
      if (skipUnlessRun)
        ifParts.push(
          "!cancelled() && !failure() && (github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success')",
        );
      if (intoGuard) ifParts.push(intoGuard);
      const env: Record<string, string> = { ...baseEnv };
      if (t.accountId !== undefined) {
        const a = accountEnv(t.accountId);
        if (a === undefined) delete env.CLOUDFLARE_ACCOUNT_ID;
        else env.CLOUDFLARE_ACCOUNT_ID = a;
      }
      Object.assign(env, t.env);
      const job = this.workflow.addJob(jobId, {
        name: t.name,
        runsOn: 'ubuntu-latest',
        needs: needs.length ? needs : undefined,
        if: ifParts.length ? ifParts.join(' && ') : undefined,
        environment: props.environment,
        permissions: props.into ? permissions : undefined,
        concurrency: props.into ? { group: `${group}-${jobId}`, cancelInProgress: false } : undefined,
        timeoutMinutes: props.timeoutMinutes ?? 15,
        env,
      });
      this.jobs.push(job);

      const guard = props.skipWhenSecretMissing;
      const add = (s: StepProps) =>
        job.addStep(guard ? { ...s, if: s.if ? `(${s.if}) && ${CONFIGURED}` : CONFIGURED } : s);
      if (guard)
        job.addStep({
          id: CONFIG_ID,
          name: 'Check configuration',
          run: [
            'if [ -n "$CLOUDFLARE_API_TOKEN" ]; then',
            '  echo "configured=true" >> "$GITHUB_OUTPUT"',
            'else',
            '  echo "::notice::CLOUDFLARE_API_TOKEN is not set; skipping deploy"',
            'fi',
          ].join('\n'),
        });
      for (const s of toolchainSteps({
        packageManager: pm,
        nodeVersion: props.nodeVersion ?? 22,
        checkoutRef: runGate
          ? '${{ github.event.workflow_run.head_sha }}'
          : skipUnlessRun
            ? '${{ github.event.workflow_run.head_sha || github.sha }}'
            : undefined,
        auth,
      }))
        add(s);
      for (const s of [...(props.preSteps ?? []), ...(t.preSteps ?? [])]) add(s);
      for (const [name, p] of Object.entries(props.prebuild ?? {}))
        add(
          typeof p === 'string'
            ? { name, run: p }
            : { name, run: p.run, env: p.env, workingDirectory: p.workingDirectory },
        );
      if (t.build) add({ name: 'Build', run: t.build, workingDirectory: t.workingDirectory });

      const wrangler = (args: string) => {
        const exec = t.filter
          ? pm === 'pnpm'
            ? `pnpm --filter ${shellSafe(t.filter, 'filter')} exec wrangler`
            : `npm exec --workspace ${shellSafe(t.filter, 'filter')} -- wrangler`
          : pm === 'pnpm'
            ? 'pnpm exec wrangler'
            : 'npx wrangler';
        return `${exec} ${args}`;
      };
      if (t.kind === 'worker') {
        if (t.d1Migrations) {
          const { database, configPath } = t.d1Migrations;
          add({
            name: 'Apply D1 migrations',
            run: wrangler(
              `d1 migrations apply ${shellSafe(database, 'd1Migrations.database')} --remote` +
                (configPath ? ` --config ${shellSafe(configPath, 'd1Migrations.configPath')}` : ''),
            ),
            workingDirectory: t.workingDirectory,
          });
        }
        add({ name: 'Deploy worker', run: t.run ?? wrangler('deploy'), workingDirectory: t.workingDirectory });
      } else {
        add({
          name: 'Deploy pages',
          run: wrangler(
            'pages deploy' +
              (t.directory ? ` ${shellSafe(t.directory, 'directory')}` : '') +
              (t.project ? ` --project-name ${shellSafe(t.project, 'project')}` : ''),
          ),
          workingDirectory: t.workingDirectory,
        });
      }
    });
  }
}
