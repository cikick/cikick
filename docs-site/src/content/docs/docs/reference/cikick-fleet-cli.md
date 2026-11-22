---
title: cikick-fleet CLI
description: Reference for the cikick-fleet binary - select, inventory, settings, secrets and report commands, options, dry-run behaviour, exit codes and status vocabularies.
---

`cikick-fleet` is provided by `@cikick/fleet`. It operates only on the repositories you have selected in `fleet.json`; every command resolves its targets through that selection and refuses anything outside it. See [Fleet](/cikick/docs/concepts/fleet/), [Fleet setup](/cikick/docs/guides/fleet-setup/) and the [fleet.json schema](/cikick/docs/reference/fleet-config/).

```text
cikick-fleet [-c, --config <path>] <command> [options]
```

## Global option

| Option                | Default      | Description                                                |
| --------------------- | ------------ | ---------------------------------------------------------- |
| `-c, --config <path>` | `fleet.json` | Path to the fleet config. Must come before the subcommand. |

## Commands

| Command                 | Purpose                                                       | Mutates                  | Dry-run default       |
| ----------------------- | ------------------------------------------------------------- | ------------------------ | --------------------- |
| `select`                | Choose the repositories the fleet operates on                 | `fleet.json`             | n/a                   |
| `inventory`             | Lockfile adoption, workflows, unpinned refs, package versions | Nothing                  | n/a                   |
| `settings diff`         | Show drift against `settingsPolicy`                           | Nothing                  | n/a                   |
| `settings apply`        | Apply `settingsPolicy`                                        | Repo Actions settings    | Yes; `--yes` to write |
| `secrets report`        | Secret age and policy status                                  | Nothing                  | n/a                   |
| `secrets rotate <name>` | Seal and write a secret value to each target                  | Repo/environment secrets | Yes; `--yes` to write |
| `report`                | Write a static HTML dashboard                                 | An HTML file             | n/a                   |

## Environment

| Variable                               | Effect                                           |
| -------------------------------------- | ------------------------------------------------ |
| `GITHUB_TOKEN`                         | GitHub token used for all API calls.             |
| `GH_TOKEN`                             | Fallback if `GITHUB_TOKEN` is unset or empty.    |
| (variable named by `--value-from-env`) | Source of the secret value for `secrets rotate`. |

If neither token variable is set, commands that call GitHub fail with `No GitHub token: set GITHUB_TOKEN or GH_TOKEN.` The token needs admin access on the target repositories for settings and secrets operations (`select` only offers repositories where you have admin permission).

## Exit codes

| Code | Meaning                                                                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. `inventory`, `settings diff`, `report`, `select` always exit `0` unless they throw.                                                                                             |
| `1`  | A thrown error (printed in red to stderr: invalid config, missing token, `NotSelectedError`, unknown group, API failure outside per-repo handling), or a command-specific failure below. |

Command-specific `1`: `settings apply` when any action has an error; `secrets report` when any row needs attention (`stale`, `missing`, `untracked-stale`); `secrets rotate` when any result is `failed`. Note that `settings diff` exits `0` even when drift exists.

## Shared narrowing options

`inventory`, `settings diff`, `settings apply`, `secrets report`, `secrets rotate` and `report` accept:

| Option               | Description                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| `--repos <names...>` | Narrow to these `owner/repo` names. Variadic; comma-separated values are also split. |
| `--group <name>`     | Narrow to a group defined in `fleet.json`.                                           |

Resolution (`resolveTargets`): start with all `repos`; `--group` replaces that with the group's members; `--repos` then intersects. Any named repo (or group member) not in `repos` throws `NotSelectedError` (`Refusing to operate on repositories not in the fleet selection: ... Add them with "cikick-fleet select --add".`). An unknown group throws `Unknown group "<name>"`. Narrowing can never widen beyond the selection.

## select

```text
cikick-fleet select [--owner <owner>] [--filter <glob>] [--add <repos...>] [--remove <repos...>] [--group <name>]
```

| Option                | Default | Description                                                                                                                                                                                |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--owner <owner>`     | none    | Interactive mode: only list repositories of this owner (case-insensitive).                                                                                                                 |
| `--filter <glob>`     | none    | Interactive mode: only list repositories whose full name or bare name matches the glob (`*`, `?`; case-insensitive).                                                                       |
| `--add <repos...>`    | none    | Add repos non-interactively (comma-separated values allowed). Each is checked with `GET /repos/{owner}/{repo}`; fails with `You do not have admin permission on <repo>` if you lack admin. |
| `--remove <repos...>` | none    | Remove repos non-interactively. Also removed from every group.                                                                                                                             |
| `--group <name>`      | none    | With `--add`: also add the repos to this group. Interactive: edit this group's membership instead of the whole selection.                                                                  |

If `fleet.json` does not exist it starts from an empty selection. With `--add` or `--remove` the change is applied directly. Otherwise it lists repositories on which you have admin (`GET /user/repos`, affiliations owner, collaborator, organization_member) and shows an interactive checkbox. Previously selected repos hidden by `--owner`/`--filter` are kept, never silently dropped. Groups left empty are removed; group members are kept only if still selected. Writes `fleet.json` (repos sorted, 2-space JSON), preserving `settingsPolicy` and `secretPolicies`.

```text
Selected 3 repositories in fleet.json
```

## inventory

```text
cikick-fleet inventory [--repos <names...>] [--group <name>] [--json]
```

| Option   | Default | Description                               |
| -------- | ------- | ----------------------------------------- |
| `--json` | off     | Print the full `InventoryResult` as JSON. |

For each target, reads `cikick.lock.json` and `.github/workflows/*.yml|yaml` through the contents API. A repo is `adopted` if it has a parseable lockfile. A workflow is `generated` if its text starts with the cikick generated header. `uses:` references are extracted from workflow text (local `./` and `docker://` refs ignored); a ref is `unpinned` unless its part after the last `@` is a 40-character lowercase hex SHA. Package versions come from the lockfile's `packages`; per package the highest version (`max`) is computed and others are listed as `outdated`. Per-repo failures set `error` on that repo and do not abort the run.

```text
acme/api  adopted
  .github/workflows/ci.yml  generated
  .github/workflows/legacy.yml  hand-written  1 unpinned
    unpinned actions/checkout@v4
acme/web  not adopted

cikick packages:
  @your-org/wf-node (max 1.3.0)
    1.3.0: acme/api
    1.2.0 outdated: acme/web
```

## settings diff

```text
cikick-fleet settings diff [--repos <names...>] [--group <name>]
```

Requires `settingsPolicy` in `fleet.json` (error: `No settingsPolicy defined in fleet config.`). Reads Actions permissions, workflow permissions, selected-actions (only when the repo's `allowedActions` is `selected` and the policy asks about it), and rulesets/branch protection (only if `requireRuleset` is set), then compares only the keys present in the policy.

Per-key status in the data model: `ok`, `drift`, `report`. The CLI prints `ok`, `drift`, and `info` for `report`. Output per key: `<status> <key>: desired <json>, actual <json>`. Keys: `defaultWorkflowPermissions`, `canApprovePullRequestReviews`, `allowedActions`, `selectedActions.githubOwnedAllowed`, `selectedActions.verifiedAllowed`, `selectedActions.patternsAllowed` (set comparison, order-insensitive), and `ruleset(<branch>)`. A read failure prints `error: <message>` after the repo name. Exit code is `0` regardless of drift.

```text
acme/api
  ok    defaultWorkflowPermissions: desired "read", actual "read"
  drift allowedActions: desired "selected", actual "all"
  info  ruleset(main): desired "present", actual "branch protection only"
```

## settings apply

```text
cikick-fleet settings apply [--repos <names...>] [--group <name>] [--yes]
```

| Option  | Default | Description                                     |
| ------- | ------- | ----------------------------------------------- |
| `--yes` | off     | Perform the writes. Without it nothing changes. |

Computes the same diff, then for drifting keys issues `PUT` calls: `/actions/permissions` (`allowedActions`, sent with `enabled: true`), `/actions/permissions/workflow` (`defaultWorkflowPermissions`, `canApprovePullRequestReviews`), and `/actions/permissions/selected-actions`. Rulesets are report-only and never written.

Output: with no `--yes` a `Dry run: nothing changed. Re-run with --yes to apply.` line, then one line per action: `would set <repo>: <description>` (dry run), `set <repo>: <description>` (applied) or `failed <repo>: <description> (<error>)`. Then `report-only <repo>: <key> is <actual>` lines, and `No changes needed.` if there were no actions. Exit `1` if any action has an error (including a settings read failure, shown as description `read settings`). In dry-run mode a read failure is still printed with the `would set` prefix and counts as an error for the exit code.

## secrets report

```text
cikick-fleet secrets report [--repos <names...>] [--group <name>] [--json] [--max-age <days>]
```

| Option             | Default                        | Description                                                              |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------ |
| `--json`           | off                            | Print the `SecretsReport` JSON (`now`, `rows`, `errors`).                |
| `--max-age <days>` | `180` (`DEFAULT_MAX_AGE_DAYS`) | Maximum age for secrets not covered by a policy. Parsed with `Number()`. |

Lists repository secrets and, for each environment, environment secrets (secret values are never readable; only `updated_at`). Each `secretPolicies` entry applying to a target repo produces a row; remaining secrets produce untracked rows. Age is whole days since `updated_at`.

| Status            | Meaning                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `ok`              | Matches a policy and age <= policy `maxAgeDays`.                                    |
| `stale`           | Matches a policy and age > `maxAgeDays`.                                            |
| `missing`         | A policy applies to the repo but no secret with that name/scope/environment exists. |
| `untracked`       | Exists, no policy; age <= `--max-age`.                                              |
| `untracked-stale` | Exists, no policy; age > `--max-age`.                                               |

Text row: `<status padded to 15> <repo>  [env:<environment>/]<name>  [<age>d (max <max>)]`, then `error <repo>: <message>` lines for repos that could not be read. Exit `1` if any row is `stale`, `missing` or `untracked-stale`; `ok` and `untracked` pass. Per-repo read errors alone do not change the exit code.

```text
ok              acme/api  NPM_TOKEN  41d (max 90)
stale           acme/api  env:production/DEPLOY_KEY  212d (max 90)
missing         acme/web  NPM_TOKEN
untracked       acme/web  SENTRY_DSN  12d (max 180)
```

## secrets rotate

```text
cikick-fleet secrets rotate <name> (--value-from-env <var> | --value-from-stdin) [--env <environment>] [--repos <names...>] [--group <name>] [--yes]
```

| Option                   | Default  | Description                                                                                      |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| `<name>`                 | required | Secret name.                                                                                     |
| `--env <environment>`    | none     | Write an environment-scoped secret; otherwise a repository secret.                               |
| `--value-from-env <var>` | none     | Read the value from this environment variable (error if empty or unset).                         |
| `--value-from-stdin`     | off      | Read the value from stdin (one trailing newline stripped; error `No value on stdin` if empty).   |
| `--yes`                  | off      | Actually write. Without it, results are `planned` and nothing is read from or written to GitHub. |

Exactly one of `--value-from-env` / `--value-from-stdin` is required in every mode, including dry-run (`Specify exactly one of --value-from-env or --value-from-stdin`). For each target the repo (or environment) public key is fetched, the value is sealed with libsodium `crypto_box_seal`, and `PUT` to the secrets API. The value is never printed or included in results.

| Status    | Meaning                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `planned` | Dry run; no API calls made.                                                                          |
| `updated` | PUT returned a status other than 201 (secret existed).                                               |
| `created` | PUT returned `201`.                                                                                  |
| `failed`  | Key fetch or PUT failed (for example `environment "<env>" not found`); message shown in parentheses. |

Output: a `Dry run: nothing written. Re-run with --yes to rotate.` line when `--yes` is absent, then `<status padded to 8> <repo> [env:<environment>/]<name>[ (<error>)]` per target. Exit `1` if any result is `failed`.

```bash
printf %s "$NEW_TOKEN" | npx cikick-fleet secrets rotate NPM_TOKEN --value-from-stdin --group libs --yes
```

```text
created  acme/api NPM_TOKEN
updated  acme/web NPM_TOKEN
failed   acme/old NPM_TOKEN (Not Found)
```

## report

```text
cikick-fleet report --html <file> [--repos <names...>] [--group <name>]
```

| Option          | Default  | Description                                        |
| --------------- | -------- | -------------------------------------------------- |
| `--html <file>` | required | Output path for the self-contained HTML dashboard. |

Gathers inventory, secrets report (default max age 180) and, if `settingsPolicy` is defined, settings diff, and writes one static page with summary cards (repositories, adopted, unpinned refs, secrets needing attention, settings drifts) and tables. Prints `Wrote <file>`. Exit code `0`.
