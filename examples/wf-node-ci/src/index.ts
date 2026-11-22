import { ManagedFile, secret, type Job, type StepProps, type Workflow as WorkflowT } from '@cikick/core';
import { Workflow } from '@cikick/core';
import { Construct } from 'constructs';

export interface NodeCiProps {
  /** Node.js major version. Default 22. */
  nodeVersion?: number;
  packageManager?: 'npm' | 'pnpm';
  /** Test command. Default `<pm> test`. */
  test?: string;
  /** Lint command, or `false` to skip. Default `<pm> run lint`. */
  lint?: string | false;
  /** Add a tag-triggered npm release job. */
  release?: { npmTokenSecret?: string };
  /** Extra steps appended to the test job. */
  extraSteps?: StepProps[];
}

/** Node.js CI: build + test (+ optional release) workflow `ci`, plus `.nvmrc` and `renovate.json`. */
export class NodeCi extends Construct {
  readonly workflow: WorkflowT;
  readonly buildJob: Job;
  /** Escape hatch: the test job. */
  readonly testJob: Job;
  readonly releaseJob?: Job;
  readonly nodeVersion: number;

  constructor(scope: Construct, id: string, props: NodeCiProps = {}) {
    super(scope, id);
    const nodeVersion = (this.nodeVersion = props.nodeVersion ?? 22);
    const pm = props.packageManager ?? 'npm';
    const run = (cmd: string) => `${pm} ${cmd}`;
    const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci';

    this.workflow = new Workflow(this, 'ci', {
      name: 'CI',
      on: { push: { branches: ['main'], tags: props.release ? ['v*'] : undefined }, pullRequest: {} },
      concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', cancelInProgress: true },
    });

    const setup = (job: Job, registry?: boolean) => {
      job.addStep({ uses: 'actions/checkout@v7' });
      if (pm === 'pnpm') job.addStep({ uses: 'pnpm/action-setup@v6' });
      job.addStep({
        uses: 'actions/setup-node@v7',
        with: {
          'node-version': nodeVersion,
          cache: pm,
          ...(registry ? { 'registry-url': 'https://registry.npmjs.org' } : {}),
        },
      });
      job.addStep({ name: 'Install', run: install });
    };

    this.buildJob = this.workflow.addJob('build', { runsOn: 'ubuntu-latest' });
    setup(this.buildJob);
    if (props.lint !== false) this.buildJob.addStep({ name: 'Lint', run: props.lint ?? run('run lint') });
    this.buildJob.addStep({ name: 'Build', run: run('run build --if-present') });

    this.testJob = this.workflow.addJob('test', { runsOn: 'ubuntu-latest', needs: this.buildJob });
    setup(this.testJob);
    this.testJob.addStep({ name: 'Test', run: props.test ?? (pm === 'npm' ? 'npm test' : 'pnpm test') });
    for (const s of props.extraSteps ?? []) this.testJob.addStep(s);

    if (props.release) {
      const job = this.workflow.addJob('release', {
        runsOn: 'ubuntu-latest',
        needs: this.testJob,
        if: "startsWith(github.ref, 'refs/tags/v')",
        permissions: { contents: 'read', idToken: 'write' },
      });
      setup(job, true);
      job.addStep({
        name: 'Publish',
        run: pm === 'pnpm' ? 'pnpm publish --provenance --no-git-checks' : 'npm publish --provenance',
        env: {
          NODE_AUTH_TOKEN: secret(this, props.release.npmTokenSecret ?? 'NPM_TOKEN', {
            maxAgeDays: 90,
            provider: 'npm',
          }),
        },
      });
      this.releaseJob = job;
    }

    new ManagedFile(this, 'nvmrc', { path: '.nvmrc', mode: 'managed', format: 'text', content: `${nodeVersion}\n` });
    new ManagedFile(this, 'renovate', {
      path: 'renovate.json',
      mode: 'merged',
      patchFile: 'renovate.patch.json',
      content: {
        $schema: 'https://docs.renovatebot.com/renovate-schema.json',
        extends: ['config:recommended'],
        // cikick.lock.json owns action pins for generated workflows (refresh with `cikick lock --refresh`).
        // Renovate must not edit generated .github/workflows/*.yml, or `cikick check` drifts / the bump is reverted on re-synth.
        'github-actions': { enabled: false },
        packageRules: [
          {
            matchPackageNames: ['@acme/wf-node-ci', '/^@cikick\\//'],
            groupName: 'cikick',
            postUpgradeTasks: {
              commands: ['npx cikick update'],
              fileFilters: ['.github/**', 'cikick.lock.json', 'renovate.json', '.nvmrc'],
              executionMode: 'branch',
            },
          },
        ],
      },
    });
  }
}
