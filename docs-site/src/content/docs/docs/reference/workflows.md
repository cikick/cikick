---
title: '@cikick/workflows'
description: API reference for @cikick/workflows - reusable NodeCi, CloudflareDeploy, BrainLint, ReleasePlease and ConventionalCommits constructs.
---

`@cikick/workflows` ships the constructs the cikick repository uses for its own CI and releases. Use them as they are, or customise them with props and [escape hatches](/cikick/docs/concepts/customisation/) (`.workflow`, `.job`, `addOverride`).

```ts title="cikick.config.ts"
import { App } from '@cikick/core';
import { applyBaseline } from '@cikick/policies';
import { ConventionalCommits, NodeCi, ReleasePlease } from '@cikick/workflows';

export default (app: App) => {
  new NodeCi(app, 'ci', { commands: { Lint: 'pnpm lint', Build: 'pnpm build', Test: 'pnpm test' } });
  new ConventionalCommits(app, 'conventional-commits');
  new ReleasePlease(app, 'release');
  applyBaseline(app);
};
```

## `NodeCi`

Workflow `ci` with a single `check` job, triggered by pull requests and pushes to `main`: checkout, (pnpm setup), `setup-node` with dependency caching, install, your commands as named steps, then `cikick check`.

| Prop               | Default                     | Notes                                                                                                                           |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `'CI'`                      | workflow name (the file is always `ci.yml`)                                                                                     |
| `nodeVersion`      | `22`                        |                                                                                                                                 |
| `packageManager`   | `'pnpm'`                    | `'npm'` uses `npm ci`                                                                                                           |
| `branches`         | `['main']`                  | push branches; pull requests always run                                                                                         |
| `triggers`         | push + pull request         | `{ push?, pullRequest?, workflowCall? }`, each `boolean` or a trigger object                                                    |
| `commands`         | `{ Build, Test }`           | step name → command, run in order                                                                                               |
| `jobs`             | none                        | parallel jobs by id: `{ name?, workingDirectory?, commands, env?, artifacts? }`; replaces `check`                               |
| `workingDirectory` | repo root                   | directory for commands (install stays at the root)                                                                              |
| `env`              | none                        | environment for every job                                                                                                       |
| `cikickCheck`      | `true` (`npx cikick check`) | string to override the command, `false` to skip; `false` by default with `jobs` (runs in the first)                             |
| `timeoutMinutes`   | `15`                        |                                                                                                                                 |
| `cancelInProgress` | `true`                      | `false`, or `'pull-request-only'` to cancel superseded pull request runs only                                                   |
| `extraPermissions` | none                        | added to `contents: read`                                                                                                       |
| `registryAuth`     | none                        | `{ scope, registry?, tokenSecret? }`: private packages via `setup-node`; token only in `NODE_AUTH_TOKEN`, adds `packages: read` |
| `fetchDepth`       | action default              | `0` for full history                                                                                                            |
| `extraSteps`       | `[]`                        | appended after `cikick check` (not with `jobs`)                                                                                 |

## `CloudflareDeploy`

Deploys with wrangler, one job per target. Its own workflow (default `deploy.yml`) runs on pushes to `branch`, or pass `into: ci.workflow` to add the jobs to an existing workflow. Concurrency never cancels (`cancel-in-progress: false`), which `@cikick/policies` enforces with `no-cancel-in-progress-deploy`.

```ts
new CloudflareDeploy(app, 'deploy', {
  environment: 'production',
  gate: { workflowRun: 'CI' }, // or { workflow: 'ci.yml' } or { jobs: [ci.jobs.test] } with `into`
  targets: [
    { kind: 'worker', workingDirectory: 'backend', d1Migrations: { database: 'app-db' } },
    { kind: 'pages', directory: 'dist', project: 'app', dependsOnPreviousTarget: true },
  ],
});
```

| Prop                                                                              | Default                                                                       | Notes                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targets`                                                                         | required                                                                      | `worker` (`run?`, `d1Migrations?`) or `pages` (`directory`, `project?`); both take `workingDirectory`, `filter`, `build`, `env`, `preSteps`, `dependsOnPreviousTarget` |
| `name` / `file` / `into`                                                          | `'deploy'` / `'deploy'` / none                                                | workflow name, file id, or an existing workflow to add jobs to                                                                                                         |
| `branch`                                                                          | `'main'`                                                                      |                                                                                                                                                                        |
| `dispatch`, `paths`                                                               | `false`, none                                                                 | `workflow_dispatch`; push path filter (not with a `workflowRun` gate)                                                                                                  |
| `environment`                                                                     | none                                                                          | GitHub environment                                                                                                                                                     |
| `gate`                                                                            | none                                                                          | `{ workflowRun }` deploys the tested commit of a successful push run; `{ workflow }` calls a reusable workflow first; `{ jobs }` adds `needs`                          |
| `secrets`                                                                         | token `CLOUDFLARE_API_TOKEN`, account `{ variable: 'CLOUDFLARE_ACCOUNT_ID' }` | `{ apiToken?, accountId?: { secret } \| { variable } \| false, scope? }`; the token is declared for the secrets manifest                                               |
| `prebuild`, `preSteps`                                                            | none                                                                          | named commands / arbitrary steps run in every job after install (`preSteps` first)                                                                                     |
| `concurrency`                                                                     | group `deploy-<environment or production>`                                    | `{ group? }`                                                                                                                                                           |
| `skipWhenSecretMissing`                                                           | `false`                                                                       | skip every step when the API token is empty                                                                                                                            |
| `permissions`, `extraTriggers`, `nodeVersion`, `packageManager`, `timeoutMinutes` | `contents: read`, none, `22`, `'pnpm'`, `15`                                  |                                                                                                                                                                        |

## `BrainLint`

Installs a pinned [delivery brain](https://github.com/craftvalueorg/delivery-brain) CLI and runs `brain lint`. Standalone it is workflow `brain.yml` with one `lint` job; pass `job: ci.job` to append the steps to an existing job.

| Prop            | Default               | Notes                                                                                          |
| --------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `cliVersion`    | required              | exact version, never `latest`                                                                  |
| `registry`      | `'npm'`               | `'github'` installs `@craftvalueorg/delivery-brain` from GitHub Packages with `packages: read` |
| `package`       | depends on `registry` |                                                                                                |
| `tokenSecret`   | `GITHUB_TOKEN`        | token for GitHub Packages, passed via `NODE_AUTH_TOKEN`                                        |
| `command`       | `'brain lint'`        |                                                                                                |
| `extraCommands` | none                  | named steps after the lint                                                                     |
| `job`           | none                  | append to this job instead of creating a workflow                                              |

`brainCliSteps(scope, options)` returns the same steps for use in your own job.

## `ReleasePlease`

Workflow `release-please` on pushes to `main`, plus `release-please-config.json` (managed) and `.release-please-manifest.json` (seeded: written once, then owned by release-please). Requires Conventional Commits on the release branch; see `ConventionalCommits`.

| Prop                    | Default          | Notes                                                                                                                                              |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`              | `['.']`          | more than one path (or a non-root path) enables `node-workspace` and a single combined PR                                                          |
| `initialVersion`        | `'0.1.0'`        | only used when the manifest is first created                                                                                                       |
| `releaseType`           | `'node'`         |                                                                                                                                                    |
| `branch`                | `'main'`         |                                                                                                                                                    |
| `appToken`              | none             | `{ appIdVariable?, privateKeySecret? }`, see below                                                                                                 |
| `config`                | `{}`             | extra top-level keys for `release-please-config.json`                                                                                              |
| `packagesConfig`        | none             | per-package config by path (`packageName`, `changelogPath`, `releaseType`, `extraFiles`, ...), written kebab-case; defaults `packages` to its keys |
| `includeComponentInTag` | monorepo: `true` | override `include-component-in-tag`                                                                                                                |
| `token`                 | none             | `{ secret, fallbackToGithubToken? }`: use a PAT (`${{ secrets.X \|\| github.token }}` with the fallback); not with `appToken`                      |
| `publish`               | none             | `{ packageManager?, build?, access?, npmTokenSecret? }`: adds a `publish` job (below)                                                              |

The job exposes `releases_created` and `paths_released` outputs. Gate a publish job on them:

```ts
const rp = new ReleasePlease(app, 'release');
rp.workflow.addJob('publish', { runsOn: 'ubuntu-latest', needs: rp.job, if: rp.releasesCreated /* ... */ });
```

**Publishing.** With `publish`, a `publish` job runs when releases were created: it builds, packs each released path (`pnpm pack` rewrites `workspace:` ranges) and runs `npm publish` on Node 24 with npm ≥ 11.5 and `id-token: write`, so packages with a [trusted publisher](https://docs.npmjs.com/trusted-publishers) configured on npmjs.com publish via OIDC with provenance and no stored token. Point the trusted publisher at this repository and the `release-please.yml` workflow. `npmTokenSecret` is a fallback for packages that don't exist on npm yet (trusted publishers can only be added to existing packages).

**Token.** By default the workflow uses `GITHUB_TOKEN` with `contents: write` and `pull-requests: write`. That needs the repository (and organisation) setting _Allow GitHub Actions to create and approve pull requests_, and release PRs opened with `GITHUB_TOKEN` do not trigger other workflows, so CI will not run on them. Pass `appToken: {}` to mint a GitHub App token instead (`actions/create-github-app-token`, app ID from the `RELEASE_APP_ID` variable, key from the `RELEASE_APP_PRIVATE_KEY` secret). The App needs read & write on Contents and Pull requests; the workflow's own token drops to `contents: read`.

## `ConventionalCommits`

Workflow `pr-title` that fails pull requests whose title is not a [Conventional Commit](https://www.conventionalcommits.org/) (`amannn/action-semantic-pull-request`). With squash merges the PR title becomes the commit on `main`, which is what release-please reads. Runs on `pull_request` with `pull-requests: read` and checks out no code.

| Prop           | Default         |
| -------------- | --------------- |
| `types`        | action defaults |
| `requireScope` | `false`         |
