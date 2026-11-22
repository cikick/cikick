import { Workflow, type Job } from '@cikick/core';
import { Construct } from 'constructs';

export interface ConventionalCommitsProps {
  /** Allowed types. Default: the action's defaults (Conventional Commits / Angular types). */
  types?: string[];
  /** Require a scope, e.g. `feat(core): ...`. Default false. */
  requireScope?: boolean;
}

/**
 * Workflow `pr-title`: fails a pull request whose title is not a Conventional Commit.
 * Pair with squash merges (PR title becomes the commit) so release-please sees conventional history.
 * Runs on `pull_request` (not `pull_request_target`) and checks out nothing.
 */
export class ConventionalCommits extends Construct {
  readonly workflow: Workflow;
  readonly job: Job;

  constructor(scope: Construct, id: string, props: ConventionalCommitsProps = {}) {
    super(scope, id);
    this.workflow = new Workflow(this, 'pr-title', {
      name: 'PR title',
      on: { pullRequest: { types: ['opened', 'edited', 'synchronize', 'reopened'] } },
      permissions: { pullRequests: 'read' },
    });
    this.job = this.workflow.addJob('conventional-title', { runsOn: 'ubuntu-latest', timeoutMinutes: 5 });
    const w: Record<string, unknown> = {};
    if (props.types) w.types = props.types.join('\n');
    if (props.requireScope) w.requireScope = true;
    this.job.addStep({
      uses: 'amannn/action-semantic-pull-request@v5',
      env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
      with: Object.keys(w).length ? w : undefined,
    });
  }
}
