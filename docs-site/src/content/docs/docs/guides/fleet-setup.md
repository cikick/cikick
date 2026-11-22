---
title: Fleet setup
description: Set up cikick-fleet on a hand-picked set of repositories - selection, groups, settings policy, secret age policy, rotation and reports.
---

You will create a dedicated repository for fleet configuration, select the repositories `cikick-fleet` may operate on, and use it to inventory them, detect settings drift, report secret age and rotate a shared secret across a group. Nothing outside the repositories you explicitly select is ever read or changed.

## Prerequisites

- Admin permission on every repository you want to manage. `select` only offers repositories where your token's user has `permissions.admin`.
- A personal access token exported as `GITHUB_TOKEN` or `GH_TOKEN` (`GITHUB_TOKEN` wins if both are set). With neither, every command fails with `No GitHub token: set GITHUB_TOKEN or GH_TOKEN.` The client takes a token only; it lists your repositories via `GET /user/repos`, so it needs a user token rather than the per-run `GITHUB_TOKEN` of a workflow.
- `@cikick/fleet` (binary `cikick-fleet`). Check that it is available on your registry before depending on it (`npm view @cikick/fleet`); the repository has it at version `0.1.0`.

## 1. Create a repository for fleet config

Fleet configuration is a single `fleet.json` file. Keep it in its own small repository so that changes to the selection, policies and groups are reviewed like code.

```bash
mkdir platform-fleet && cd platform-fleet
git init
npm init -y
npm install --save-dev @cikick/fleet
```

Run the tool from that directory with `npx cikick-fleet ...`. By default it reads and writes `./fleet.json`; use the global option `-c, --config <path>` (before the subcommand) for another path.

## 2. Create a token with the right access

The scopes below are **derived from the GitHub API routes the code calls**, not from official cikick documentation. Verify them against GitHub's documentation for each route before granting.

| Command | Routes used | Needs |
|---|---|---|
| `select` | `GET /user/repos`, `GET /repos/{o}/{r}` | read access to repository metadata; admin on the repos you choose |
| `inventory`, `report` | `GET /repos/{o}/{r}/contents/{path}` (`cikick.lock.json`, `.github/workflows`) | contents read |
| `secrets report` | `GET /repos/{o}/{r}/actions/secrets`, `GET /repos/{o}/{r}/environments`, `GET .../environments/{env}/secrets` | actions secrets read, environments read |
| `secrets rotate` | `GET`+`PUT /repos/{o}/{r}/actions/secrets/...` and `.../environments/{env}/secrets/...` (public key, then PUT) | actions secrets read and write, environments read |
| `settings diff`, `report` | `GET .../actions/permissions`, `.../permissions/workflow`, `.../permissions/selected-actions`, `.../rulesets`, `.../branches/{b}/protection` | actions/administration read (for the Actions permission routes), rulesets and branch protection read |
| `settings apply --yes` | `PUT .../actions/permissions`, `.../permissions/workflow`, `.../permissions/selected-actions` | actions/administration write |

With a classic token, the `repo` scope is the simplest superset of the above. With a fine-grained token, grant the matching repository permissions on exactly the repositories you plan to select. A `403` from the branch protection route is tolerated (treated as "not protected"); other errors are reported per repository as `error <repo>: <message>` (secrets) or `error: <message>` (inventory, settings) and the run continues with the next repository.

Secret **values** can never be read; reports use only names and `updated_at` timestamps.

## 3. Select the repositories

### Interactive

```bash
export GITHUB_TOKEN=...
npx cikick-fleet select --owner acme --filter 'svc-*'
```

`select` lists the repositories you have admin permission on (sorted by name), optionally narrowed with `--owner <owner>` and `--filter <glob>` (matched case-insensitively against `owner/repo` or the bare repo name; `*` and `?` are supported), and shows a checkbox list with your current selection ticked. When you confirm it writes `fleet.json` and prints:

```text
Selected 6 repositories in fleet.json
```

Repositories that were already selected but are hidden by `--owner`/`--filter` stay selected; a filter never silently drops them.

### Non-interactive

```bash
npx cikick-fleet select --add acme/svc-api,acme/svc-web acme/svc-worker --group prod-deployers
npx cikick-fleet select --remove acme/svc-legacy
```

- `--add` and `--remove` take `owner/repo` values separated by commas or spaces. Invalid names are rejected.
- Each `--add` is verified with `GET /repos/{owner}/{repo}`; if you lack admin permission the command fails with `You do not have admin permission on <repo>`.
- `--group <name>` with `--add` also puts the added repositories in that group (creating it). With the interactive form, `--group <name>` edits that group's membership (chosen repositories are also added to the selection).
- `--remove` removes the repository from the selection and from every group. Empty groups are deleted.
- `--owner` and `--filter` only apply to the interactive form.

Every selected repository must be of the form `owner/repo`.

## 4. Edit `fleet.json`: groups and policies

`select` writes `repos` (sorted) and `groups`. Add `settingsPolicy` and `secretPolicies` by hand. A complete example:

```json title="fleet.json"
{
  "repos": [
    "acme/svc-api",
    "acme/svc-web",
    "acme/svc-worker",
    "acme/tools"
  ],
  "groups": {
    "prod-deployers": ["acme/svc-api", "acme/svc-web", "acme/svc-worker"]
  },
  "settingsPolicy": {
    "defaultWorkflowPermissions": "read",
    "canApprovePullRequestReviews": false,
    "allowedActions": "selected",
    "selectedActions": {
      "githubOwnedAllowed": true,
      "verifiedAllowed": false,
      "patternsAllowed": ["pnpm/action-setup@*"]
    },
    "requireRuleset": { "branch": "main" }
  },
  "secretPolicies": [
    { "name": "DEPLOY_KEY", "scope": "env", "environment": "production", "maxAgeDays": 30, "group": "prod-deployers" },
    { "name": "NPM_TOKEN", "scope": "repo", "maxAgeDays": 90 }
  ]
}
```

The file is validated on every command. Rules (from the config loader):

- `repos` is required: an array of `owner/repo` strings.
- `groups` (optional): an object mapping a name to a list of repos; **every group member must also be in `repos`**.
- `settingsPolicy` (optional), all fields optional:
  - `defaultWorkflowPermissions`: `read` or `write`
  - `canApprovePullRequestReviews`: boolean
  - `allowedActions`: `all`, `local_only` or `selected`
  - `selectedActions`: `{ githubOwnedAllowed?: boolean, verifiedAllowed?: boolean, patternsAllowed?: string[] }`
  - `requireRuleset`: `{ branch: string }` (non-empty). This one is reported, never applied.
- `secretPolicies` (optional): each entry needs `name`, `scope` (`repo` or `env`), `maxAgeDays` (a positive number), and `environment` when `scope` is `env`. Optional `repos` (each must be in the top-level `repos`) or `group` (must exist) restricts which selected repositories the policy covers; with neither, it covers all selected repositories. Org-scoped secrets are not supported by the fleet.
- Violations fail with `Invalid fleet config: <path>: <message>`, for example `Invalid fleet config: groups.prod-deployers: acme/x is not in "repos"`.

`select` preserves `groups`, `settingsPolicy` and `secretPolicies` when it rewrites the file.

### Narrowing any command

Every command except `select` accepts `--repos <names...>` (selected repos) and `--group <name>` to narrow further. They can be combined (intersection).

:::note[Nothing outside the selection is touched]
Targets are always computed from `fleet.json`'s `repos`. Asking for a repository that is not selected, or for a group containing one, fails before any API call with:

```text
Refusing to operate on repositories not in the fleet selection: acme/other. Add them with "cikick-fleet select --add".
```

(`NotSelectedError`.) The only way to widen the scope is to change the selection with `select`, which is a reviewable change to `fleet.json`. There is no "all repositories in the organisation" mode.
:::

## 5. Inventory

```bash
npx cikick-fleet inventory
```

For each selected repository it reads `cikick.lock.json` and `.github/workflows/*.yml|yaml` through the contents API. Example output (colours omitted):

```text
acme/svc-api  adopted
  .github/workflows/ci.yml  generated
  .github/workflows/legacy.yml  hand-written  2 unpinned
    unpinned actions/checkout@v4
    unpinned codecov/codecov-action@v3
acme/tools  not adopted
  .github/workflows/build.yml  hand-written  1 unpinned
    unpinned actions/checkout@v4

cikick packages:
  @acme/wf-node-ci (max 2.0.0)
    2.0.0: acme/svc-api
    1.4.0 outdated: acme/svc-web
```

- `adopted` means the repository has a readable `cikick.lock.json`; `generated` means the workflow starts with the cikick header.
- `unpinned` lists `uses:` refs whose ref is not a 40-character SHA (local `./` and `docker://` refs are ignored).
- The package table groups repositories by the package versions recorded in each lockfile, marking versions below the highest as outdated.
- `--json` prints the structured result.

## 6. Settings drift

```bash
npx cikick-fleet settings diff
```

```text
acme/svc-api
  ok    defaultWorkflowPermissions: desired "read", actual "read"
  drift canApprovePullRequestReviews: desired false, actual true
  info  ruleset(main): desired "present", actual "branch protection only"
acme/tools
  ...
```

`ok` and `drift` compare policy to reality. `info` lines (the `requireRuleset` check) are informational only. Apply the fixes:

```bash
npx cikick-fleet settings apply            # dry run (default)
npx cikick-fleet settings apply --yes      # actually write
```

Dry-run output:

```text
Dry run: nothing changed. Re-run with --yes to apply.
would set acme/svc-api: canApprovePullRequestReviews -> false
report-only acme/svc-api: ruleset(main) is "branch protection only"
```

With `--yes`, lines read `set <repo>: <description>` or `failed <repo>: ... (<error>)`, and the exit code is `1` if any write failed. When nothing drifted: `No changes needed.`

Details to know:

- `apply` manages allowed actions, default workflow permissions, can-approve-PR-reviews and selected-actions. It never creates or changes rulesets.
- When setting `allowedActions`, `apply` sends `enabled: true` as well.
- Selected-actions details are only read when the repository's `allowedActions` is `selected`. Set `allowedActions: "selected"` alongside `selectedActions` in the policy; `apply` writes `allowedActions` first.
- `settings diff` and `settings apply` require a `settingsPolicy` in `fleet.json` (`No settingsPolicy defined in fleet config.` otherwise).

## 7. Secret age report

```bash
npx cikick-fleet secrets report
```

```text
ok              acme/svc-web  env:production/DEPLOY_KEY  12d (max 30)
stale           acme/svc-api  env:production/DEPLOY_KEY  41d (max 30)
missing         acme/svc-worker  env:production/DEPLOY_KEY
untracked       acme/svc-api  SENTRY_DSN  60d (max 180)
untracked-stale acme/tools  OLD_TOKEN  400d (max 180)
```

For each selected repository the fleet lists repository secrets and the secrets of each environment, then compares them with `secretPolicies` that cover that repository:

| Status | Meaning |
|---|---|
| `ok` | a policy matches and the secret's age is within `maxAgeDays` |
| `stale` | a policy matches and `updated_at` is older than `maxAgeDays` |
| `missing` | a policy covers the repository but no such secret (or environment) exists |
| `untracked` | a secret exists that no policy covers; younger than the default maximum |
| `untracked-stale` | an uncovered secret older than the default maximum |

The default maximum for uncovered secrets is 180 days; override with `--max-age <days>`. The exit code is `1` when any row is `stale`, `missing` or `untracked-stale` (plain `untracked` does not count), so it can gate a scheduled job. `--json` prints the report.

Per-repository API failures print as `error <repo>: <message>` and are listed separately; they do **not** change the exit code, so look at the output (or the JSON `errors` array) in automation.

Only secrets matching a policy entry are checked for `missing`. Secrets declared by workflows (see [Secrets](/cikick/docs/concepts/secrets/) and `npx cikick secrets` in each repository) are not read by the fleet; mirror what matters into `secretPolicies`.

## 8. Rotate a secret across a group

Worked example: `DEPLOY_KEY` (environment `production`) is older than its 30 day policy in some repositories of `prod-deployers`.

1. Find out what needs attention:

   ```bash
   npx cikick-fleet secrets report --group prod-deployers
   echo $?   # 1 if anything is stale or missing
   ```

2. Generate the new credential and install it wherever it is validated (the deployment target). `cikick-fleet` only writes the value to GitHub; it does not create or revoke keys.

3. Put the new value in an environment variable (or pipe it on stdin) and dry-run:

   ```bash
   export NEW_DEPLOY_KEY="$(cat ./new-deploy-key)"
   npx cikick-fleet secrets rotate DEPLOY_KEY --env production --group prod-deployers --value-from-env NEW_DEPLOY_KEY
   ```

   ```text
   Dry run: nothing written. Re-run with --yes to rotate.
   planned  acme/svc-api env:production/DEPLOY_KEY
   planned  acme/svc-web env:production/DEPLOY_KEY
   planned  acme/svc-worker env:production/DEPLOY_KEY
   ```

4. Write it:

   ```bash
   npx cikick-fleet secrets rotate DEPLOY_KEY --env production --group prod-deployers --value-from-env NEW_DEPLOY_KEY --yes
   ```

   ```text
   updated  acme/svc-api env:production/DEPLOY_KEY
   updated  acme/svc-web env:production/DEPLOY_KEY
   created  acme/svc-worker env:production/DEPLOY_KEY
   ```

   For each repository the fleet fetches the environment's public key, encrypts the value with a libsodium sealed box, and `PUT`s it. `created` means the secret did not exist before, `updated` that it did. A failure prints `failed   <repo> env:production/DEPLOY_KEY (<message>)` for that repository, processing continues, and the exit code is `1`.

5. Confirm:

   ```bash
   npx cikick-fleet secrets report --group prod-deployers
   ```

   All three rows should now be `ok` with an age of `0d`.

Options and behaviour:

- Give exactly one of `--value-from-env <VAR>` or `--value-from-stdin`, otherwise: `Specify exactly one of --value-from-env or --value-from-stdin`. An empty or unset variable fails with `Environment variable <VAR> is empty or unset`.
- From stdin, one trailing newline is stripped, so `pbpaste | npx cikick-fleet secrets rotate ... --value-from-stdin --yes` and `printf %s "$VALUE" | ...` both work. The value is never printed or included in results.
- Omit `--env` for a repository-level secret.
- `--group` and `--repos` narrow targets; targets outside the selection are refused. `rotate` does not consult `secretPolicies`, so the repositories it writes are exactly the ones you target.
- An environment that does not exist in a repository gives `failed ... (environment "production" not found)`; create the environment first.
- Without `--yes` nothing is written and no GitHub requests are made.

## 9. HTML report

```bash
npx cikick-fleet report --html fleet-report.html
```

```text
Wrote fleet-report.html
```

The static page combines the inventory, secret report and (when `settingsPolicy` is set) settings drift for the selected repositories. `--html <file>` is required. `--repos`/`--group` narrow it. It is a good artifact for a scheduled workflow.

## Troubleshooting

**`Cannot read fleet config at fleet.json. Run "cikick-fleet select" to create one.`** You are in the wrong directory, or have not run `select`. Use `-c <path>` to point elsewhere.

**`Unknown group "x"`.** The group is not in `fleet.json` `groups`.

**Repository missing from the interactive list.** Only repositories where `permissions.admin` is true for your token's user appear; check `--owner`/`--filter`.

**`Refusing to operate on repositories not in the fleet selection`.** A `--repos` value, group member or policy refers to a repository that is not in `repos`. Add it with `select --add` or fix the argument.

**Settings or secrets calls fail with 403/404 for some repositories.** The token lacks the permission for that route (see the table in section 2), or the repository has no such environment. The error is shown for that repository only; others are processed.
