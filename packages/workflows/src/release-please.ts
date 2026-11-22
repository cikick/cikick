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
  /** Add a `publish` job that publishes the packages released by this run to npm. */
  publish?: ReleasePleasePublish;
}

export interface ReleasePleasePublish {
  /** Default `pnpm`. pnpm rewrites `workspace:` ranges when packing. */
  packageManager?: 'npm' | 'pnpm';
  /** Build command run before packing. Default `<pm> run build`; `false` to skip. */
  build?: string | false;
  /** `npm publish --access`. Default `public`. */
  access?: 'public' | 'restricted';
  /**
   * Fallback secret for `NODE_AUTH_TOKEN`. Publishing uses npm trusted publishing (OIDC) when the package
   * has a trusted publisher configured on npmjs.com; a token is only needed for packages that don't exist yet.
   */
  npmTokenSecret?: string;
}

/**
 * release-please: workflow `release-please`, a managed `release-please-config.json` and a seeded
 * `.release-please-manifest.json` (release-please owns it after creation).
 * Downstream jobs can `needs: rp.job` and test `rp.releasesCreated`.
 */
export class ReleasePlease extends Construct {
  readonly workflow: Workflow;
  readonly job: Job;
  /** The `publish` job, when `publish` is set. */
  readonly publishJob?: Job;
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
        uses: 'actions/create-github-app-token@v3',
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
      uses: 'googleapis/release-please-action@v5',
      with: token ? { token } : undefined,
    });
    if (props.publish) this.publishJob = this.addPublishJob(props.publish);
  }

  private addPublishJob(p: ReleasePleasePublish): Job {
    const pm = p.packageManager ?? 'pnpm';
    const job = this.workflow.addJob('publish', {
      runsOn: 'ubuntu-latest',
      needs: this.job,
      if: this.releasesCreated,
      timeoutMinutes: 15,
      permissions: { contents: 'read', idToken: 'write' },
    });
    job.addStep({ uses: 'actions/checkout@v7' });
    if (pm === 'pnpm') job.addStep({ uses: 'pnpm/action-setup@v6' });
    // Node 24 + npm >= 11.5 for trusted publishing (OIDC) and automatic provenance.
    job.addStep({
      uses: 'actions/setup-node@v7',
      with: { 'node-version': 24, cache: pm, 'registry-url': 'https://registry.npmjs.org' },
    });
    job.addStep({ name: 'Update npm', run: 'npm install -g npm@^11.5.1' });
    job.addStep({ name: 'Install', run: pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci' });
    if (p.build !== false) job.addStep({ name: 'Build', run: p.build ?? `${pm} run build` });
    const env: Record<string, string> = { PATHS_RELEASED: '${{ needs.release-please.outputs.paths_released }}' };
    if (p.npmTokenSecret)
      env.NODE_AUTH_TOKEN = secret(this, p.npmTokenSecret, {
        provider: 'npm',
        maxAgeDays: 90,
        description: 'npm token fallback for first publishes',
      });
    job.addStep({
      name: 'Publish released packages',
      env,
      run: [
        'set -euo pipefail',
        'out="$RUNNER_TEMP/packages"; mkdir -p "$out"',
        `for p in $(jq -r '.[]' <<<"$PATHS_RELEASED"); do (cd "$p" && ${pm} pack --pack-destination "$out"); done`,
        // Idempotent: skip versions already on the registry so a re-run after a partial failure can finish the rest.
        'for f in "$out"/*.tgz; do',
        '  spec=$(tar -xOf "$f" package/package.json | jq -r \'.name + "@" + .version\')',
        '  if npm view "$spec" version >/dev/null 2>&1; then echo "skip $spec (already published)"; continue; fi',
        `  npm publish "$f" --access ${p.access ?? 'public'}`,
        'done',
      ].join('\n'),
    });
    return job;
  }
}
