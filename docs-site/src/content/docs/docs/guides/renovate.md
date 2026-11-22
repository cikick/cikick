---
title: Renovate setup
description: Configure Renovate so that bumping a cikick package runs migrations and regenerates workflows in the same pull request.
---

You will configure Renovate so that when it bumps `@cikick/*` or a shared workflow package, it also runs `npx cikick update` and commits the regenerated workflows, lockfile and any migrated config to the update PR. The reviewer sees one diff: the dependency bump, the migration edits and the changed generated YAML.

## 1. The Renovate configuration

This is the real `renovate.json` of the example consumer (`examples/consumer`):

```json title="renovate.json"
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "github-actions": {
    "enabled": false
  },
  "packageRules": [
    {
      "matchPackageNames": ["@acme/wf-node-ci", "/^@cikick\\//"],
      "groupName": "cikick",
      "postUpgradeTasks": {
        "commands": ["npx cikick update"],
        "fileFilters": [".github/**", "cikick.lock.json", "renovate.json", ".nvmrc"],
        "executionMode": "branch"
      }
    }
  ],
  "schedule": ["before 5am on monday"],
  "labels": ["dependencies"]
}
```

What the pieces do:

- `matchPackageNames` selects the packages whose upgrades should trigger regeneration: your shared workflow packages and everything under `@cikick/`. The `/^@cikick\\//` form is a Renovate regex match.
- `groupName: "cikick"` puts all of them in one PR, so the CLI, core and shared packages move together.
- `postUpgradeTasks.commands` runs `npx cikick update` in the upgrade branch.
- `fileFilters` lists the globs of files Renovate should add to the commit after the command ran. Anything `cikick update` changes that is not covered by a filter is **not** committed. Include `.github/**` (generated workflows), `cikick.lock.json`, and every managed file your packages generate. Add `cikick.config.ts` if a package's migrations edit it (the snippet printed by `cikick init` includes it). Note that the example `NodeCi` package's own `fileFilters` do not list `cikick.config.ts`, although its 2.0.0 migration edits that file; add it through your own config if you rely on such migrations.
- `executionMode: "branch"` runs the command once per branch (after all upgrades in the group), not once per package.

### The snippet from `cikick init`

`npx cikick init` prints this starting point (it does not write it):

```json
{
  "extends": ["config:recommended"],
  "packageRules": [
    {
      "matchPackageNames": ["@cikick/**", "@your-org/wf-**"],
      "postUpgradeTasks": {
        "commands": ["npx cikick update"],
        "fileFilters": [".github/**", "cikick.lock.json", "cikick.config.ts"],
        "executionMode": "branch"
      }
    }
  ]
}
```

Replace `@your-org/wf-**` with the names of your shared packages.

## 2. Let the package manage `renovate.json` (merged pattern)

The example `NodeCi` construct ships `renovate.json` as a `merged` managed file: the package supplies the base (shown above, minus `schedule` and `labels`), and the consumer supplies overrides in a repo-owned `renovate.patch.json`:

```json title="renovate.patch.json"
{
  "schedule": ["before 5am on monday"],
  "labels": ["dependencies"]
}
```

`cikick synth` deep-merges the patch over the package's base and writes `renovate.json`, which is what produced the file in section 1. Rules of the merge:

- objects merge recursively;
- arrays and scalars in the patch **replace** the base value;
- `null` in the patch deletes the key.

:::caution
Because arrays are replaced, putting a `packageRules` array in `renovate.patch.json` replaces the package's rule, including its `postUpgradeTasks`. Either repeat the rule in your patch or add your rules some other way. Never edit `renovate.json` itself: it is regenerated, and `cikick check` reports hand edits as drift.
:::

This pattern keeps the update loop configured the same way across every repository that uses the package. Authors: see [Authoring a package](/cikick/docs/guides/authoring-a-package/#3-ship-managed-files). Concepts: [Managed files](/cikick/docs/concepts/managed-files/).

## 3. How the update loop works

1. Renovate opens a branch bumping, for example, `@acme/wf-node-ci` from `1.4.0` to `2.0.0` in `package.json` and your lockfile.
2. The `postUpgradeTasks` command `npx cikick update` runs in that branch.
3. `cikick update` compares each discovered package's installed version with the version recorded in `cikick.lock.json` (`packages`). For every package where the version moved, it selects the package's migrations with `from < version <= to` and runs them in order. These can edit `cikick.config.ts` (via ts-morph) and delete or write repo files.
4. It then runs a normal `synth`: regenerates workflows and managed files, resolves any action refs that are new to the lock (via `git ls-remote`), and records the new package versions in `cikick.lock.json`.
5. Renovate commits the files matching `fileFilters` to the branch. The PR now contains the dependency bump, the migrated config and the regenerated YAML.
6. Your CI runs [`cikick check`](/cikick/docs/guides/ci-check/) on the PR and must pass before merge.

Typical `update` output in the task log:

```text
@acme/wf-node-ci: 1.4.0 -> 2.0.0
migrate @acme/wf-node-ci@2.0.0: Rename NodeCi prop `node` to `nodeVersion`; remove legacy cikick-generated .github/workflows/node.yml
renamed 1 `node` prop(s) to `nodeVersion`
wrote .github/workflows/ci.yml
wrote cikick.lock.json
```

For a package seen for the first time (no entry in the lock) it logs `first adoption, recording version (no migrations)`. See [Migrations](/cikick/docs/concepts/migrations/).

## 4. Pinned action digests: cikick versus Renovate

There are two mechanisms that both talk about pinning actions to digests. They cover different files.

**cikick** pins every action used by a _generated_ workflow. The construct or config says `actions/checkout@v4`; at synth time cikick resolves `v4` to a commit SHA, stores it in `cikick.lock.json` keyed `actions/checkout@v4`, and renders `uses: actions/checkout@<sha> # v4`. The pin lives in the lockfile, and existing entries are trusted on later syntheses. (See [Lockfile and pinning](/cikick/docs/concepts/lockfile-and-pinning/).)

**Renovate's `helpers:pinGitHubActionDigests`** pins and updates actions inside workflow files it finds in the repository. That is useful for hand-written workflows that cikick does not generate.

How they interact:

- Generated workflow files are rewritten by `cikick synth`. Hand-bumping an action ref or SHA inside a generated YAML file is pointless: the next synth reverts it, and until then `cikick check` fails with drift.
- Action version bumps for generated workflows happen at the source: change the ref in the construct or package (`actions/checkout@v4` to `@v5`) and run `npx cikick synth`. The new key is not in the lock, so it is resolved and recorded; keys no longer used are dropped from the lock on the next write.
- A floating ref such as `@v4` stays pinned to the SHA recorded at the time. To pick up newer commits for existing refs, run `npx cikick synth --refresh`, which re-resolves all refs and rewrites the workflows and lockfile (`npx cikick lock --refresh` updates only the lockfile, which leaves the workflows drifting until the next synth). Do this on a schedule or in a dedicated PR if you want it.
- The managed `renovate.json` therefore disables Renovate's `github-actions` manager and does not extend `helpers:pinGitHubActionDigests`: `cikick.lock.json` owns the pins of generated workflows. Refresh them with `cikick lock --refresh` (or `cikick synth --refresh`). If you also keep hand-written workflows, re-enable the manager in `renovate.patch.json` with `ignorePaths`/`packageRules` that exclude the generated files.
- If you see Renovate PRs editing files under `.github/workflows` that cikick generates, those PRs will fail `cikick check` and will be overwritten by the next synth. If you re-enabled the manager, exclude those files from it (for example with a `packageRules` entry using `matchFileNames` and `enabled: false`) after checking the option names against the Renovate docs for your version. This guide does not verify Renovate's behaviour for already-pinned refs.

`cikick-fleet inventory` flags any `uses:` in a repository's workflows that is not a 40-hex SHA, which helps find repositories that still have unpinned hand-written workflows.

## 5. Caveats to verify for your Renovate deployment

:::caution
`postUpgradeTasks` commands are not run by default everywhere. Check these against your Renovate deployment before relying on the loop:

- **Self-hosted Renovate:** commands must match the host's `allowedPostUpgradeCommands` list (regexes), for example `["^npx cikick update$"]`. Otherwise the task is rejected.
- **Mend-hosted Renovate app:** support for `postUpgradeTasks` has limits (which commands are allowed, whether the repository is installed, what tooling is available in the runner). Consult Mend's documentation or support for your plan.
- **Installed dependencies:** `cikick update` reads installed package versions from `node_modules` and loads your config and the shared packages from there. Confirm that dependencies are installed and up to date in the Renovate runner at the time the command runs. If they are not, install them first, for example `"commands": ["pnpm install --frozen-lockfile", "npx cikick update"]` (and allow both commands).
- **Network:** `update` resolves new action refs with `git ls-remote https://github.com/...` and falls back to the GitHub API (using `GITHUB_TOKEN` if set). The runner needs outbound access to `github.com`.
:::

None of this is checked by cikick. If the task fails or is skipped, the PR will contain only the dependency bump and `cikick check` in CI will fail on lockfile drift (the installed version no longer matches the recorded one). That is the intended safety net.

## Troubleshooting

**The PR has the bump but no regenerated files.** Either the post-upgrade command was not allowed or did not run (section 5), or the generated paths are not in `fileFilters`. Add every path `cikick update` writes: `.github/**`, `cikick.lock.json`, `cikick.config.ts`, and each managed file such as `.nvmrc` or `renovate.json`.

**Someone bumped a package by hand and ran `cikick synth`.** `synth` records the installed package version in the lock, so the migrations for that bump are never selected afterwards. Use `npx cikick update` for bumps. To run missed migrations: `npx cikick migrate <pkg> --from <previous-version>`.

**Dry run in a branch.** `npx cikick update --dry-run` prints `would run <pkg>@<version>: <description>` for each pending migration and `no migrations to run` otherwise; it changes nothing.

**`cikick check` fails on the Renovate PR with `drift: cikick.lock.json`.** The lock still records the old package version, or an action ref changed without a re-synth. Run `npx cikick update` and commit.

**Patch to `renovate.json` has no effect.** Edit `renovate.patch.json`, then run `npx cikick synth`. `renovate.json` is a generated file.
