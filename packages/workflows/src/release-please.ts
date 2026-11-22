import { ManagedFile, Workflow, secret, type Job } from '@cikick/core';
import { Construct } from 'constructs';

const PUBLISH_ALL = 'publish_all';

/** `packageName` -> `package-name`; keys that are already kebab-case pass through. */
const kebabKeys = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), v]));

export interface ReleasePleaseAppToken {
  /** Repository/org variable holding the GitHub App ID. Default `RELEASE_APP_ID`. */
  appIdVariable?: string;
  /** Secret holding the App's private key. Default `RELEASE_APP_PRIVATE_KEY`. */
  privateKeySecret?: string;
}

export interface ReleasePleaseToken {
  /** Secret holding a token (e.g. a PAT) for release-please, so release PRs trigger CI. */
  secret: string;
  /** Fall back to the workflow's `github.token` when the secret is empty. Default false. */
  fallbackToGithubToken?: boolean;
}

/** Per-package entry of `release-please-config.json`. camelCase keys are written kebab-case (`packageName` -> `package-name`). */
export interface ReleasePleasePackageConfig {
  packageName?: string;
  changelogPath?: string;
  releaseType?: string;
  extraFiles?: unknown[];
  [key: string]: unknown;
}

export interface ReleasePleaseProps {
  /** Workflow name. Default `Release`. */
  name?: string;
  /** Workflow file id (`.github/workflows/<file>.yml`). Default `release-please`. The job id stays `release-please`. */
  file?: string;
  /**
   * Add `workflow_dispatch`. Default `true` (with a `publish_all` input when `publish` is set); `false` removes the
   * trigger and the input.
   */
  workflowDispatch?: boolean;
  /** Condition of the release-please job (`if:`), e.g. `github.repository == 'org/repo'`. */
  if?: string;
  /**
   * `separate-pull-requests`. Default: `false` for a monorepo, unset for a single root package. Set it to emit the
   * key either way.
   */
  separatePullRequests?: boolean;
  /** `plugins`. Default: `['node-workspace']` for a monorepo, none for a single root package. `[]` emits none. */
  plugins?: string[];
  /** Package paths to release (`'.'` for a single-package repo). Default: the keys of `packagesConfig`, else `['.']`. */
  packages?: string[];
  /** Per-package config written under `packages` in `release-please-config.json`. Keys must be in `packages`. */
  packagesConfig?: Record<string, ReleasePleasePackageConfig>;
  /** Override `include-component-in-tag`. Default: `true` for monorepos, unset for a single root package. */
  includeComponentInTag?: boolean;
  /** Run with this token instead of `GITHUB_TOKEN`. Not combinable with `appToken`. */
  token?: ReleasePleaseToken;
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
    if (props.token && props.appToken) throw new Error('ReleasePlease: `token` and `appToken` are mutually exclusive');
    const packages = props.packages ?? (props.packagesConfig ? Object.keys(props.packagesConfig) : ['.']);
    for (const k of Object.keys(props.packagesConfig ?? {}))
      if (!packages.includes(k)) throw new Error(`ReleasePlease: packagesConfig key "${k}" is not in packages`);
    const monorepo = packages.length > 1 || packages[0] !== '.';
    const plugins = props.plugins ?? (monorepo ? ['node-workspace'] : []);
    const publishAll = !!props.publish && props.workflowDispatch !== false;

    new ManagedFile(this, 'config', {
      path: 'release-please-config.json',
      mode: 'managed',
      content: {
        $schema: 'https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json',
        'release-type': props.releaseType ?? 'node',
        ...(monorepo ? { 'include-component-in-tag': true } : {}),
        ...(props.separatePullRequests !== undefined
          ? { 'separate-pull-requests': props.separatePullRequests }
          : monorepo
            ? { 'separate-pull-requests': false }
            : {}),
        ...(plugins.length ? { plugins } : {}),
        ...(props.includeComponentInTag !== undefined
          ? { 'include-component-in-tag': props.includeComponentInTag }
          : {}),
        ...props.config,
        packages: Object.fromEntries(packages.map((p) => [p, kebabKeys(props.packagesConfig?.[p] ?? {})])),
      },
    });
    new ManagedFile(this, 'manifest', {
      path: '.release-please-manifest.json',
      mode: 'seeded',
      content: Object.fromEntries(packages.map((p) => [p, props.initialVersion ?? '0.1.0'])),
    });

    this.workflow = new Workflow(this, props.file ?? 'release-please', {
      name: props.name ?? 'Release',
      on: {
        push: { branches: [props.branch ?? 'main'] },
        ...(props.workflowDispatch === false
          ? {}
          : {
              workflowDispatch: publishAll
                ? {
                    inputs: {
                      [PUBLISH_ALL]: {
                        description:
                          'Publish every configured package that is not yet on npm (recovery after a failed publish)',
                        type: 'boolean',
                        default: false,
                      },
                    },
                  }
                : {},
            }),
      },
      // A dedicated token does the writing; with a `github.token` fallback the workflow token must be able to as well.
      permissions:
        props.appToken || (props.token && !props.token.fallbackToGithubToken)
          ? { contents: 'read' }
          : { contents: 'write', pullRequests: 'write' },
      concurrency: { group: 'release-please', cancelInProgress: false },
    });
    const job = (this.job = this.workflow.addJob('release-please', {
      runsOn: 'ubuntu-latest',
      if: props.if,
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
    if (props.token) {
      const ref = secret(this, props.token.secret, { description: 'Token used by release-please' });
      token = props.token.fallbackToGithubToken ? ref.replace(' }}', ' || github.token }}') : ref;
    }
    job.addStep({
      id: 'release',
      uses: 'googleapis/release-please-action@v5',
      with: token ? { token } : undefined,
    });
    if (props.publish) this.publishJob = this.addPublishJob(props.publish, packages, publishAll);
  }

  private addPublishJob(p: ReleasePleasePublish, packages: string[], publishAll: boolean): Job {
    const pm = p.packageManager ?? 'pnpm';
    const job = this.workflow.addJob('publish', {
      runsOn: 'ubuntu-latest',
      needs: this.job,
      // Also runs on a manual dispatch with `publish_all`, to finish a release whose publish partly failed.
      if: publishAll ? `${this.releasesCreated} || inputs.${PUBLISH_ALL}` : this.releasesCreated,
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
    const env: Record<string, string> = {
      PATHS_RELEASED: publishAll
        ? `\${{ inputs.${PUBLISH_ALL} && '${JSON.stringify(packages)}' || needs.release-please.outputs.paths_released }}`
        : '${{ needs.release-please.outputs.paths_released }}',
    };
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
