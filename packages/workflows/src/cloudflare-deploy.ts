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
import { shellSafe, toolchainSteps, type PackageManager } from './support.js';

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
  /** Directory of built assets, `wrangler pages deploy <directory>`. */
  directory: string;
  /** `--project-name`. Omit to use the wrangler config. */
  project?: string;
}

export type CloudflareTarget = CloudflareWorkerTarget | CloudflarePagesTarget;

export type CloudflareGate =
  /** Deploy after another workflow succeeds on `branch` (`on: workflow_run`); checks out the tested commit. */
  | { workflowRun: string | string[] }
  /** Call a reusable workflow (`./.github/workflows/<file>`, which needs `on: workflow_call`) first. */
  | { workflow: string; permissions?: Permissions; secrets?: 'inherit' }
  /** `needs` these jobs. They must belong to the workflow passed as `into`. */
  | { jobs: Job[] };

export interface CloudflareDeploySecrets {
  /** Secret holding the API token. Default `CLOUDFLARE_API_TOKEN`. */
  apiToken?: string;
  /**
   * Account id, exported as `CLOUDFLARE_ACCOUNT_ID`. `{ variable }` reads `vars.<name>`, `{ secret }` a secret,
   * `false` omits it. Default `{ variable: 'CLOUDFLARE_ACCOUNT_ID' }`.
   */
  accountId?: { secret: string } | { variable: string } | false;
  /** Scope recorded for the declared secrets. Default `repo` (`env` when the secret lives in `environment`). */
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
  /** Also allow manual runs (`workflow_dispatch`). Default false. */
  dispatch?: boolean;
  /** Only pushes touching these paths deploy. Not allowed with a `workflowRun` gate. */
  paths?: string[];
  /** GitHub environment of the deploy jobs. */
  environment?: string;
  /** What must pass before deploying. Without a gate, deploys on push to `branch`. */
  gate?: CloudflareGate;
  nodeVersion?: number;
  packageManager?: PackageManager;
  /** Named steps run in every target job after install, before the target's own steps (e.g. build shared packages). */
  prebuild?: Record<string, string>;
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
    const group = props.concurrency?.group ?? `deploy-${props.environment ?? 'production'}`;

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
        permissions: props.permissions ?? { contents: 'read' },
        concurrency: { group, cancelInProgress: false },
      });
    }

    const needsBase: (string | Job)[] = [];
    if (gate && 'workflow' in gate) {
      const file = gate.workflow.startsWith('./') ? gate.workflow : `./.github/workflows/${gate.workflow}`;
      this.gateJob = this.workflow.addJob('gate', {
        uses: file,
        permissions: gate.permissions ?? { contents: 'read' },
        secrets: gate.secrets,
      });
      needsBase.push(this.gateJob);
    }
    if (gate && 'jobs' in gate) needsBase.push(...gate.jobs);

    const sec = props.secrets ?? {};
    const secretOpts = {
      scope: sec.scope ?? (props.environment ? 'env' : 'repo'),
      environment: props.environment,
    } as const;
    const baseEnv: Record<string, string> = {
      CLOUDFLARE_API_TOKEN: secret(this, sec.apiToken ?? 'CLOUDFLARE_API_TOKEN', {
        ...secretOpts,
        provider: 'cloudflare',
        description: 'Cloudflare API token used by wrangler',
      }),
    };
    const account = sec.accountId ?? { variable: 'CLOUDFLARE_ACCOUNT_ID' };
    if (account !== false)
      baseEnv.CLOUDFLARE_ACCOUNT_ID =
        'variable' in account
          ? `\${{ vars.${account.variable} }}`
          : secret(this, account.secret, {
              ...secretOpts,
              provider: 'cloudflare',
              description: 'Cloudflare account id',
            });

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
      const env = { ...baseEnv, ...t.env };
      const job = this.workflow.addJob(jobId, {
        name: t.name,
        runsOn: 'ubuntu-latest',
        needs: needs.length ? needs : undefined,
        if: ifParts.length ? ifParts.join(' && ') : undefined,
        environment: props.environment,
        permissions: props.into ? (props.permissions ?? { contents: 'read' }) : undefined,
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
        checkoutRef: runGate ? '${{ github.event.workflow_run.head_sha }}' : undefined,
      }))
        add(s);
      for (const s of [...(props.preSteps ?? []), ...(t.preSteps ?? [])]) add(s);
      for (const [name, run] of Object.entries(props.prebuild ?? {})) add({ name, run });
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
            `pages deploy ${shellSafe(t.directory, 'directory')}` +
              (t.project ? ` --project-name ${shellSafe(t.project, 'project')}` : ''),
          ),
          workingDirectory: t.workingDirectory,
        });
      }
    });
  }
}
