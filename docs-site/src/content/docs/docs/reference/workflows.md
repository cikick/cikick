---
title: '@cikick/workflows'
description: API reference for @cikick/workflows - reusable NodeCi, ReleasePlease and ConventionalCommits constructs.
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

| Prop             | Default                     | Notes                                           |
| ---------------- | --------------------------- | ----------------------------------------------- |
| `nodeVersion`    | `22`                        |                                                 |
| `packageManager` | `'pnpm'`                    | `'npm'` uses `npm ci`                           |
| `branches`       | `['main']`                  | push branches; pull requests always run         |
| `commands`       | `{ Build, Test }`           | step name → command, run in order               |
| `cikickCheck`    | `true` (`npx cikick check`) | string to override the command, `false` to skip |
| `timeoutMinutes` | `15`                        |                                                 |
| `extraSteps`     | `[]`                        | appended after `cikick check`                   |

## `ReleasePlease`

Workflow `release-please` on pushes to `main`, plus `release-please-config.json` (managed) and `.release-please-manifest.json` (seeded: written once, then owned by release-please). Requires Conventional Commits on the release branch; see `ConventionalCommits`.

| Prop             | Default   | Notes                                                                                     |
| ---------------- | --------- | ----------------------------------------------------------------------------------------- |
| `packages`       | `['.']`   | more than one path (or a non-root path) enables `node-workspace` and a single combined PR |
| `initialVersion` | `'0.1.0'` | only used when the manifest is first created                                              |
| `releaseType`    | `'node'`  |                                                                                           |
| `branch`         | `'main'`  |                                                                                           |
| `appToken`       | none      | `{ appIdVariable?, privateKeySecret? }`, see below                                        |
| `config`         | `{}`      | extra top-level keys for `release-please-config.json`                                     |
| `publish`        | none      | `{ packageManager?, build?, access?, npmTokenSecret? }`: adds a `publish` job (below)     |

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
