---
title: Fleet
description: cikick-fleet operates on a repository selection you make explicitly - inventory, settings drift, secret age and rotation, and an HTML report - with dry-run defaults and no implicit org-wide reach.
---

Once dozens of repos use shared workflows, the questions change: which repos have adopted cikick, who is on an old package version, which still have unpinned actions, whose Actions settings drifted, whose deploy key is two years old. `cikick-fleet` answers them over a **list of repositories that you chose**. It never discovers or touches "everything in the org"; a repo that is not in your selection cannot be read or modified by any command.

Setup walkthrough: [Fleet setup guide](/cikick/docs/guides/fleet-setup/). Option lists: [fleet CLI reference](/cikick/docs/reference/cikick-fleet-cli/) and [fleet.json reference](/cikick/docs/reference/fleet-config/).

## The selection

The selection is a JSON file (`fleet.json` by default; `-c, --config <path>` to change it), usually kept in a small private repo of its own:

```json title="fleet.json"
{
  "repos": ["acme/api", "acme/web", "acme/infra"],
  "groups": { "backend": ["acme/api", "acme/infra"] },
  "settingsPolicy": { "defaultWorkflowPermissions": "read" },
  "secretPolicies": [{ "name": "NPM_TOKEN", "scope": "repo", "maxAgeDays": 90, "group": "backend" }]
}
```

- `repos` is the allowlist. Entries must look like `owner/repo`.
- `groups` are named subsets; every member must also be in `repos`.
- A `secretPolicies` entry's `repos` must be in `repos` and its `group` must exist. Validation errors name the offending path (`Invalid fleet config: groups.backend: ... is not in "repos"`).
- The file is created and edited by `cikick-fleet select`; it can also be edited by hand.

Every command that acts on repos takes `--repos a/b,c/d` and `--group name` to **narrow** the selection further. Narrowing is the only direction allowed: `resolveTargets` returns a subset of `repos`, and asking for anything else throws `NotSelectedError` ("Refusing to operate on repositories not in the fleet selection ... Add them with `cikick-fleet select --add`") before any API call.

## Authentication

Fleet uses a GitHub token from `GITHUB_TOKEN`, falling back to `GH_TOKEN`. Without either, commands fail with `No GitHub token: set GITHUB_TOKEN or GH_TOKEN.` The token needs whatever the operations need: read access to contents, Actions settings and secrets metadata for inventory/reports; admin-level write access for `settings apply` and `secrets rotate`. Use a token scoped to the selected repos where you can.

## Commands

### `select`

Chooses the repos.

- Interactive (no `--add`/`--remove`): lists repos the authenticated user has **admin** permission on (optionally `--owner`, `--filter <glob>`) as a checkbox list and saves the result. Previously selected repos that the filter hid are kept, so a filter never drops them silently.
- Non-interactive: `--add a/b c/d` verifies you have admin on each added repo, then adds it; `--remove` removes (also from groups). `--group <name>` assigns added repos to a group, or in interactive mode edits that group's membership.

### `inventory` (read-only)

For each selected repo, reads `cikick.lock.json` and `.github/workflows/*.yml|yaml` through the contents API and reports: whether the repo is **adopted** (has a lockfile), each workflow as `generated` (starts with the cikick header) or `hand-written`, every remote `uses:` that is not pinned to a 40-hex SHA, and the cikick package versions from each lock. Package versions are compared across the selection: the highest version is "max" and others are flagged `outdated`. This is relative to your selection, not to the registry. `--json` for machine output.

### `settings diff` and `settings apply`

Compares repo Actions settings with `settingsPolicy`. Only keys present in the policy are checked:

| Policy key                                                                   | Behaviour                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultWorkflowPermissions` (`read`/`write`)                                | Diffed and applied.                                                                                                                               |
| `canApprovePullRequestReviews` (boolean)                                     | Diffed and applied.                                                                                                                               |
| `allowedActions` (`all`/`local_only`/`selected`)                             | Diffed and applied.                                                                                                                               |
| `selectedActions.githubOwnedAllowed`, `.verifiedAllowed`, `.patternsAllowed` | Diffed and applied (pattern lists compared as sets). Read only when the repo's allowed-actions mode is `selected`.                                |
| `requireRuleset: { branch }`                                                 | **Report-only.** Shows whether an active ruleset covers the branch (or branch protection only, or none). `apply` never creates or edits rulesets. |

`settings apply` is a **dry run unless `--yes`**: without it, it prints `would set <repo>: ...` and changes nothing. With `--yes` it issues the PUT calls and exits 1 if any fail.

### `secrets report`

Lists secret **names and ages** (GitHub's `updated_at`) for repo-level and environment-level secrets of the selected repos; it cannot see values. Each row gets a status:

| Status            | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `ok`              | Matches a `secretPolicies` entry and is within `maxAgeDays`.               |
| `stale`           | Matches a policy but older than its `maxAgeDays`.                          |
| `missing`         | A policy applies to this repo but no such secret exists.                   |
| `untracked`       | Exists, matches no policy, within the default max age.                     |
| `untracked-stale` | Exists, matches no policy, older than the default (`--max-age`, 180 days). |

The command exits 1 if any row is `stale`, `missing` or `untracked-stale`. Per-repo API errors are printed but do not set the exit code by themselves. `--json` for machine output.

### `secrets rotate <NAME>`

Writes one new value to the same secret in every target repo. The value comes from exactly one of `--value-from-env VAR` or `--value-from-stdin` (never as a command-line argument). Use `--env <environment>` for an environment secret; otherwise it is a repo secret.

For each repo it fetches the repo's (or environment's) public key, encrypts the value with a libsodium sealed box (`crypto_box_seal`), and PUTs the ciphertext with the key id. This is what GitHub's API requires; the plaintext leaves your machine only inside that encrypted payload, and results never contain the value. **Dry run unless `--yes`**: without it every target prints `planned`. Results are `created`, `updated` or `failed`; any failure exits 1.

Rotation does not consult `secretPolicies`; it acts on the targets you narrow to.

### `report --html <file>`

Writes a static HTML dashboard of the selection: inventory, package versions, unpinned actions, secret ages, and (if `settingsPolicy` is defined) settings drift.

## What is not implemented

`docs/PLAN.md` describes some behaviour that the code does not have. Treat these as planned:

- **Organisation-scoped secrets.** Policies and rotation support `repo` and `env` scopes only. `secret()` can declare `org`, but fleet cannot report on or rotate those.
- **Missing secrets from each repo's cikick manifest.** `secrets report` marks a secret `missing` only relative to `secretPolicies`. It does not read repos' `cikick.config.ts` or the manifest from [`cikick secrets`](/cikick/docs/concepts/secrets/).
- **`fleet.config.ts`.** Only `fleet.json` is read.
- **Creating or editing rulesets** through `settings apply`: ruleset coverage is reported, not changed.
- **Action SHAs in use** are not listed per repo; inventory lists the unpinned ones.

## Gotchas

- Dry-run is the default for every write command, but it is still reading from GitHub, so the token and network are required.
- `inventory` treats a repo as adopted only if `cikick.lock.json` at the repo root parses as JSON; if it exists but does not parse, the repo is reported with an error instead.
- `settings apply` reports each failed PUT per repo (`failed <repo>: ...`) and keeps going with the remaining repos.
