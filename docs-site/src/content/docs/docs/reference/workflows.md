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

| Prop               | Default                     | Notes                                                                                                                                                    |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `'CI'`                      | workflow name (the file is always `ci.yml`)                                                                                                              |
| `nodeVersion`      | `22`                        |                                                                                                                                                          |
| `packageManager`   | `'pnpm'`                    | `'npm'` uses `npm ci`                                                                                                                                    |
| `branches`         | `['main']`                  | push branches; pull requests always run                                                                                                                  |
| `triggers`         | push + pull request         | `{ push?, pullRequest?, workflowCall?, workflowDispatch? }`, each `boolean` or a trigger object (`workflowDispatch` is off by default)                   |
| `commands`         | `{ Build, Test }`           | step name → command, run in order                                                                                                                        |
| `jobs`             | none                        | parallel jobs by id: `{ name?, workingDirectory?, commands, env?, artifacts?, if?, permissions? }`; replaces `check`; artifacts use `upload-artifact@v7` |
| `workingDirectory` | repo root                   | directory for commands (install stays at the root)                                                                                                       |
| `env`              | none                        | environment for every job                                                                                                                                |
| `cikickCheck`      | `true` (`npx cikick check`) | string to override the command, `false` to skip; `false` by default with `jobs` (runs in the first)                                                      |
| `timeoutMinutes`   | `15`                        |                                                                                                                                                          |
| `cancelInProgress` | `true`                      | `false`, or `'pull-request-only'` to cancel superseded pull request runs only                                                                            |
| `extraPermissions` | none                        | added to `contents: read`                                                                                                                                |
| `registryAuth`     | none                        | `{ scope, registry?, tokenSecret? }`: private packages via `setup-node`; token only in `NODE_AUTH_TOKEN`, adds `packages: read`                          |
| `fetchDepth`       | action default              | `0` for full history                                                                                                                                     |
| `installStepName`  | `'Install'`                 | name of the install step                                                                                                                                 |
| `extraSteps`       | `[]`                        | appended after `cikick check` (not with `jobs`)                                                                                                          |

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

| Prop                                                                              | Default                                                                       | Notes                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targets`                                                                         | required                                                                      | `worker` (`run?`, `d1Migrations?`) or `pages` (`directory?`, `project?`; omit `directory` when the wrangler config sets `pages_build_output_dir`); both take `id`, `name`, `workingDirectory`, `filter`, `build`, `env`, `preSteps`, `dependsOnPreviousTarget`, `accountId?` (overrides `secrets.accountId` for that job) |
| `name` / `file` / `into`                                                          | `'deploy'` / `'deploy'` / none                                                | workflow name, file id, or an existing workflow to add jobs to                                                                                                                                                                                                                                                            |
| `branch`                                                                          | `'main'`                                                                      |                                                                                                                                                                                                                                                                                                                           |
| `dispatch`, `paths`                                                               | `false`, none                                                                 | `workflow_dispatch`; push path filter (not with a `workflowRun` gate). With `into`, `dispatch` only widens the guard: the target workflow needs its own `workflow_dispatch` trigger (`NodeCi` `triggers.workflowDispatch`)                                                                                                |
| `if`                                                                              | see below                                                                     | with `into`: replaces the default deploy guard; `false` adds none                                                                                                                                                                                                                                                         |
| `environment`                                                                     | none                                                                          | GitHub environment                                                                                                                                                                                                                                                                                                        |
| `gate`                                                                            | none                                                                          | `{ workflowRun }` deploys the tested commit of a successful push run; `{ workflow, id?, if?, permissions?, secrets?, skipUnlessWorkflowRunSucceeded? }` calls a reusable workflow first (job id `gate`, or `id`); `{ jobs }` adds `needs`                                                                                 |
| `secrets`                                                                         | token `CLOUDFLARE_API_TOKEN`, account `{ variable: 'CLOUDFLARE_ACCOUNT_ID' }` | `{ apiToken?: string \| { secret, scope? }, accountId?: { secret, scope? } \| { variable } \| false, scope? }`; `scope` is the default for secrets without their own; declared for the secrets manifest                                                                                                                   |
| `prebuild`, `preSteps`                                                            | none                                                                          | named commands (`'cmd'` or `{ run, env?, workingDirectory? }`) / arbitrary steps run in every job after install (`preSteps` first)                                                                                                                                                                                        |
| `registryAuth`                                                                    | none                                                                          | `{ scope, registry?, tokenSecret? }` as in `NodeCi`: authenticated install, adds `packages: read`                                                                                                                                                                                                                         |
| `concurrency`                                                                     | group `deploy-<environment or production>`                                    | `{ group? }`                                                                                                                                                                                                                                                                                                              |
| `skipWhenSecretMissing`                                                           | `false`                                                                       | skip every step when the API token is empty                                                                                                                                                                                                                                                                               |
| `permissions`, `extraTriggers`, `nodeVersion`, `packageManager`, `timeoutMinutes` | `contents: read`, none, `22`, `'pnpm'`, `15`                                  |                                                                                                                                                                                                                                                                                                                           |

**Guard with `into`.** Deploy jobs added to an existing workflow (usually CI, which also runs on pull requests) get `if: github.ref == 'refs/heads/<branch>' && github.event_name == 'push'`, extended with `|| github.event_name == 'workflow_dispatch'` when `dispatch` is set. Override with `if`, or pass `if: false`. Own workflows are already limited by their triggers.

**Push plus `workflow_run`.** To deploy on pushes (after a reusable CI gate) and also after another workflow finishes, add the trigger with `extraTriggers: { workflowRun: { workflows: ['Data refresh'], types: ['completed'], branches: ['main'] } }` and set `gate: { workflow: 'ci.yml', skipUnlessWorkflowRunSucceeded: true }`. The gate is skipped for `workflow_run` events, the deploy runs only if the triggering run succeeded (or the gate passed) and checks out `workflow_run.head_sha`. Not available with `into`.

## `BrainLint`

Installs a pinned [delivery brain](https://github.com/craftvalueorg/delivery-brain) CLI and runs `brain lint`. Standalone it is workflow `brain.yml` with one `lint` job; pass `job: ci.job` to append the steps to an existing job.

| Prop            | Default                      | Notes                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cliVersion`    | required unless `fromSource` | exact version, never `latest`                                                                                                                                                                                                                                                                                          |
| `registry`      | `'npm'`                      | `'github'` installs `@craftvalueorg/delivery-brain` from GitHub Packages with `packages: read`                                                                                                                                                                                                                         |
| `package`       | depends on `registry`        |                                                                                                                                                                                                                                                                                                                        |
| `tokenSecret`   | `GITHUB_TOKEN`               | token for GitHub Packages, passed via `NODE_AUTH_TOKEN`                                                                                                                                                                                                                                                                |
| `command`       | `'brain lint'`               |                                                                                                                                                                                                                                                                                                                        |
| `fromSource`    | none                         | run this local command (e.g. `pnpm brain lint --quiet`) instead of installing the CLI; `cliVersion` becomes optional and `registry`, `package`, `tokenSecret` are rejected. Standalone, the job gets checkout, pnpm, Node and install (`packageManager?`, `registryAuth?`); with `job`, the job must already have them |
| `extraCommands` | none                         | named steps after the lint                                                                                                                                                                                                                                                                                             |
| `job`           | none                         | append to this job instead of creating a workflow                                                                                                                                                                                                                                                                      |

`brainCliSteps(scope, options)` returns the same steps for use in your own job.

## `ReleasePlease`

Workflow `release-please` on pushes to `main`, plus `release-please-config.json` (managed) and `.release-please-manifest.json` (seeded: written once, then owned by release-please). Requires Conventional Commits on the release branch; see `ConventionalCommits`.

| Prop                    | Default                                   | Notes                                                                                                                                              |
| ----------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`              | `['.']`                                   | more than one path (or a non-root path) enables `node-workspace` and a single combined PR                                                          |
| `initialVersion`        | `'0.1.0'`                                 | only used when the manifest is first created                                                                                                       |
| `releaseType`           | `'node'`                                  |                                                                                                                                                    |
| `branch`                | `'main'`                                  |                                                                                                                                                    |
| `appToken`              | none                                      | `{ appIdVariable?, privateKeySecret? }`, see below                                                                                                 |
| `config`                | `{}`                                      | extra top-level keys for `release-please-config.json`                                                                                              |
| `packagesConfig`        | none                                      | per-package config by path (`packageName`, `changelogPath`, `releaseType`, `extraFiles`, ...), written kebab-case; defaults `packages` to its keys |
| `includeComponentInTag` | monorepo: `true`                          | override `include-component-in-tag`                                                                                                                |
| `token`                 | none                                      | `{ secret, fallbackToGithubToken? }`: use a PAT (`${{ secrets.X \|\| github.token }}` with the fallback); not with `appToken`                      |
| `publish`               | none                                      | `{ packageManager?, build?, access?, npmTokenSecret? }`: adds a `publish` job (below)                                                              |
| `name` / `file`         | `'Release'` / `'release-please'`          | workflow name and file id (the job id stays `release-please`)                                                                                      |
| `workflowDispatch`      | `true`                                    | `false` removes the trigger (and the `publish_all` recovery input)                                                                                 |
| `separatePullRequests`  | monorepo: `false`, else unset             | emits `separate-pull-requests`, also for a single package                                                                                          |
| `plugins`               | monorepo: `['node-workspace']`, else none | replaces the default; `[]` emits none                                                                                                              |
| `if`                    | none                                      | condition of the `release-please` job                                                                                                              |

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

## `toolchainSteps`

`toolchainSteps({ packageManager?, nodeVersion?, fetchDepth?, checkoutRef?, auth?, installStepName? })` returns the steps every construct above starts with: checkout, pnpm setup (pnpm only), `setup-node` with dependency caching, and the frozen-lockfile install. Use it in your own workflows; `resolveRegistryAuth(scope, { scope: '@org', registry?, tokenSecret? })` produces `auth` for private packages (grant `packages: read` yourself).

```ts
const wf = new Workflow(app, 'nightly', {
  name: 'nightly',
  on: { schedule: [{ cron: '0 3 * * *' }] },
  permissions: { contents: 'read', packages: 'read' },
});
const job = wf.addJob('run', { runsOn: 'ubuntu-latest', timeoutMinutes: 15 });
for (const s of toolchainSteps({ auth: resolveRegistryAuth(wf, { scope: '@acme' }) })) job.addStep(s);
job.addStep({ name: 'Run', run: 'pnpm nightly' });
```
