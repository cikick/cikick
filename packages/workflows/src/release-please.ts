import { ManagedFile, Workflow, secret, type Job } from '@cikick/core';
import { Construct } from 'constructs';

export interface ReleasePleaseAppToken {
  /** Repository/org variable holding the GitHub App ID. Default `RELEASE_APP_ID`. */
  appIdVariable?: string;
  /** Secret holding the App's private key. Default `RELEASE_APP_PRIVATE_KEY`. */
  privateKeySecret?: string;
}

export interface ReleasePleaseProps {
  /** Package paths to release (`'.'` for a single-package repo). Default `['.']`. */
  packages?: string[];
  /** Version written to `.release-please-manifest.json` when it is first created. Default `0.1.0`. */
  initialVersion?: string;
  /** release-please release type. Default `node`. */
  releaseType?: string;
  /** Branch releases are cut from. Default `main`. */
  branch?: string;
  /**
   * Run with a GitHub App token instead of `GITHUB_TOKEN`, so release PRs trigger CI and the repo/org
   * setting "Allow GitHub Actions to create and approve pull requests" can stay off.
   */
  appToken?: ReleasePleaseAppToken;
  /** Extra keys merged into `release-please-config.json` (top level). */
  config?: Record<string, unknown>;
}

/**
 * release-please: workflow `release-please`, a managed `release-please-config.json` and a seeded
 * `.release-please-manifest.json` (release-please owns it after creation).
 * Downstream jobs can `needs: rp.job` and test `rp.releasesCreated`.
 */
export class ReleasePlease extends Construct {
  readonly workflow: Workflow;
  readonly job: Job;
  /** Expression, usable in a dependent job's `if:`, true when this run created releases. */
  readonly releasesCreated = "needs.release-please.outputs.releases_created == 'true'";

  constructor(scope: Construct, id: string, props: ReleasePleaseProps = {}) {
    super(scope, id);
    const packages = props.packages ?? ['.'];
    const monorepo = packages.length > 1 || packages[0] !== '.';

    new ManagedFile(this, 'config', {
      path: 'release-please-config.json',
      mode: 'managed',
      content: {
        $schema: 'https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json',
        'release-type': props.releaseType ?? 'node',
        ...(monorepo
          ? { 'include-component-in-tag': true, 'separate-pull-requests': false, plugins: ['node-workspace'] }
          : {}),
        ...props.config,
        packages: Object.fromEntries(packages.map((p) => [p, {}])),
      },
    });
    new ManagedFile(this, 'manifest', {
      path: '.release-please-manifest.json',
      mode: 'seeded',
      content: Object.fromEntries(packages.map((p) => [p, props.initialVersion ?? '0.1.0'])),
    });

    this.workflow = new Workflow(this, 'release-please', {
      name: 'Release',
      on: { push: { branches: [props.branch ?? 'main'] }, workflowDispatch: {} },
      permissions: props.appToken ? { contents: 'read' } : { contents: 'write', pullRequests: 'write' },
      concurrency: { group: 'release-please', cancelInProgress: false },
    });
    const job = (this.job = this.workflow.addJob('release-please', {
      runsOn: 'ubuntu-latest',
      timeoutMinutes: 10,
      outputs: {
        releases_created: '${{ steps.release.outputs.releases_created }}',
        paths_released: '${{ steps.release.outputs.paths_released }}',
      },
    }));
    let token: string | undefined;
    if (props.appToken) {
      job.addStep({
        id: 'app-token',
        uses: 'actions/create-github-app-token@v2',
        with: {
          'app-id': `\${{ vars.${props.appToken.appIdVariable ?? 'RELEASE_APP_ID'} }}`,
          'private-key': secret(this, props.appToken.privateKeySecret ?? 'RELEASE_APP_PRIVATE_KEY', {
            description: 'GitHub App private key used by release-please',
          }),
        },
      });
      token = '${{ steps.app-token.outputs.token }}';
    }
    job.addStep({
      id: 'release',
      uses: 'googleapis/release-please-action@v4',
      with: token ? { token } : undefined,
    });
  }
}
