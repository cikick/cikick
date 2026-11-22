import { Workflow, type Job, type StepProps } from '@cikick/core';
import { Construct } from 'constructs';

export interface NodeCiProps {
  /** Node.js major version. Default 22. */
  nodeVersion?: number;
  /** Default `pnpm` (uses `pnpm/action-setup`, version from `packageManager` in package.json). */
  packageManager?: 'npm' | 'pnpm';
  /** Branches whose pushes run CI (pull requests always do). Default `['main']`. */
  branches?: string[];
  /** Commands run in order after install, each as a named step. Default: build, test. */
  commands?: Record<string, string>;
  /** Run `cikick check` last: `true` (default) runs `npx cikick check`, a string overrides the command, `false` skips. */
  cikickCheck?: boolean | string;
  /** Job timeout. Default 15. */
  timeoutMinutes?: number;
  /** Extra steps appended at the end of the job. */
  extraSteps?: StepProps[];
}

/** Single-job Node.js CI workflow `ci`: checkout, setup, install, your commands, then `cikick check`. */
export class NodeCi extends Construct {
  readonly workflow: Workflow;
  /** Escape hatch: the `check` job. */
  readonly job: Job;

  constructor(scope: Construct, id: string, props: NodeCiProps = {}) {
    super(scope, id);
    const pm = props.packageManager ?? 'pnpm';
    const run = (script: string) => (pm === 'pnpm' ? `pnpm ${script}` : `npm run ${script}`);

    this.workflow = new Workflow(this, 'ci', {
      name: 'CI',
      on: { push: { branches: props.branches ?? ['main'] }, pullRequest: {} },
      permissions: { contents: 'read' },
      concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', cancelInProgress: true },
    });
    const job = (this.job = this.workflow.addJob('check', {
      runsOn: 'ubuntu-latest',
      timeoutMinutes: props.timeoutMinutes ?? 15,
    }));
    job.addStep({ uses: 'actions/checkout@v4' });
    if (pm === 'pnpm') job.addStep({ uses: 'pnpm/action-setup@v4' });
    job.addStep({ uses: 'actions/setup-node@v4', with: { 'node-version': props.nodeVersion ?? 22, cache: pm } });
    job.addStep({ name: 'Install', run: pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci' });
    const commands = props.commands ?? { Build: run('build'), Test: pm === 'pnpm' ? 'pnpm test' : 'npm test' };
    for (const [name, cmd] of Object.entries(commands)) job.addStep({ name, run: cmd });
    const check = props.cikickCheck ?? true;
    if (check !== false) job.addStep({ name: 'cikick check', run: check === true ? 'npx cikick check' : check });
    for (const s of props.extraSteps ?? []) job.addStep(s);
  }
}
