---
title: fleet.json schema
description: Schema, validation rules and programmatic API for the cikick-fleet configuration file.
---

`fleet.json` declares which repositories the fleet may touch and the policies it checks. The CLI reads it with `loadConfig`, validating it with `validateConfig`; any violation throws `ConfigError` with the message `Invalid fleet config: <path>: <message>`. Related: [cikick-fleet CLI](/cikick/docs/reference/cikick-fleet-cli/), [Fleet](/cikick/docs/concepts/fleet/), [Fleet setup](/cikick/docs/guides/fleet-setup/).

## Top-level keys

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `repos` | `string[]` | yes | The selection. Each entry must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` (`owner/repo`). |
| `groups` | `Record<string, string[]>` | no | Named subsets of `repos`. Every member must be in `repos`. |
| `settingsPolicy` | `SettingsPolicy` | no | Desired repository Actions settings. |
| `secretPolicies` | `SecretPolicy[]` | no | Expected secrets and maximum ages. |

Unknown top-level keys are ignored by validation and dropped when `saveConfig` rewrites the file. `saveConfig` writes `repos` sorted, then `groups` (only if non-empty), `settingsPolicy`, `secretPolicies`, as 2-space JSON with a trailing newline.

## settingsPolicy

Only keys you set are compared or applied.

| Key | Allowed values | Description |
| --- | --- | --- |
| `defaultWorkflowPermissions` | `"read"` \| `"write"` | Default `GITHUB_TOKEN` permissions. |
| `canApprovePullRequestReviews` | `boolean` | Whether workflows may approve pull request reviews. |
| `allowedActions` | `"all"` \| `"local_only"` \| `"selected"` | Which actions may run. |
| `selectedActions.githubOwnedAllowed` | `boolean` | Allow GitHub-owned actions (when `allowedActions` is `selected`). |
| `selectedActions.verifiedAllowed` | `boolean` | Allow verified-creator actions. |
| `selectedActions.patternsAllowed` | `string[]` | Allowed action patterns; compared as an unordered set. |
| `requireRuleset` | `{ branch: string }` | Report-only: a non-disabled branch ruleset must cover `refs/heads/<branch>` (or include `~DEFAULT_BRANCH` / `~ALL`). Never applied. Reported as `info` when absent, with `branch protection only` or `none` as the actual value. |

Validation errors: `settingsPolicy: expected an object`; `settingsPolicy.<key>: expected one of ...`; `expected boolean`; `settingsPolicy.selectedActions: expected an object`; `settingsPolicy.selectedActions.patternsAllowed: expected string[]`; `settingsPolicy.requireRuleset: expected { branch: string }` (branch must be a non-empty string).

## secretPolicies[]

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | yes | Secret name. Non-empty. |
| `scope` | `"repo"` \| `"env"` | yes | Repository or environment secret. |
| `environment` | `string` | when `scope` is `"env"` | Environment name. Non-empty. |
| `maxAgeDays` | `number` | yes | Maximum age in days; must be a positive number. |
| `repos` | `string[]` | no | Restrict the policy to these repos; each must be in top-level `repos`. |
| `group` | `string` | no | Restrict the policy to this group; must exist in `groups`. |

With neither `repos` nor `group` the policy applies to every selected repo. If both are given, `repos` narrows the group. The `--repos`/`--group` CLI options narrow further.

Validation errors (path prefix `secretPolicies[i]`): `.name: expected non-empty string`; `.scope: expected one of repo, env`; `.environment: required when scope is "env"`; `.maxAgeDays: expected positive number`; `.repos: <r> is not in "repos"` (and `expected "owner/repo"` for malformed entries); `.group: unknown group "<g>"`. For `groups`: `groups.<g>: <r> is not in "repos"`; `groups: expected an object of name -> repo[]`. `secretPolicies: expected an array`; the root must be an object (`$: expected an object`).

## Constants

| Name | Value | Description |
| --- | --- | --- |
| `DEFAULT_MAX_AGE_DAYS` | `180` | Max age for secrets without a policy; overridden by `secrets report --max-age`. |
| `DEFAULT_CONFIG_PATH` | `"fleet.json"` | Default config path. |

## Annotated example

```json title="fleet.json"
{
  "repos": [
    "acme/api",
    "acme/web",
    "acme/libs-core"
  ],
  "groups": {
    "libs": ["acme/libs-core"],
    "apps": ["acme/api", "acme/web"]
  },
  "settingsPolicy": {
    "defaultWorkflowPermissions": "read",
    "canApprovePullRequestReviews": false,
    "allowedActions": "selected",
    "selectedActions": {
      "githubOwnedAllowed": true,
      "verifiedAllowed": false,
      "patternsAllowed": ["step-security/harden-runner@*"]
    },
    "requireRuleset": { "branch": "main" }
  },
  "secretPolicies": [
    { "name": "NPM_TOKEN", "scope": "repo", "maxAgeDays": 90, "group": "libs" },
    { "name": "DEPLOY_KEY", "scope": "env", "environment": "production", "maxAgeDays": 90, "repos": ["acme/api"] }
  ]
}
```

- `repos` is the full selection; nothing outside it is ever touched.
- `groups` entries are subsets of `repos`, usable via `--group`.
- `settingsPolicy` uses GitHub's `selected` mode, so the three `selectedActions` keys are compared and applied; `requireRuleset` only reports.
- `secretPolicies[0]` applies to `libs` only; `[1]` is an environment secret limited to one repo.

## Programmatic API (`@cikick/fleet`)

The package root re-exports everything below.

### Types

| Export | Description |
| --- | --- |
| `FleetConfig`, `SettingsPolicy`, `SecretPolicy`, `RepoRef` | Config types (`RepoRef` = `{ owner, repo, full }`). |
| `GitHubClient` | `{ request(route, params?): Promise<{status, data}>; paginate(route, params?): Promise<any[]> }`. All I/O goes through it, so it can be mocked. |
| `AdminRepo`, `SelectChange`, `TargetOptions` | Selection helper types. |
| `WorkflowInfo`, `RepoInventory`, `PackageSummary`, `InventoryResult` | Inventory results. |
| `RepoSettingsState`, `SettingDiff`, `RepoSettingsDiff`, `ApplyAction`, `ApplyResult` | Settings results. |
| `SecretStatus`, `SecretRow`, `SecretsReport`, `RotateOptions`, `RotateResult` | Secrets results. |
| `FleetReportData` | Input of the HTML renderer. |
| `CliDeps` | Injectable dependencies for `buildProgram`: `client`, `out`, `readStdin`, `env`, `choose`. |

### Config

| Signature | Description |
| --- | --- |
| `loadConfig(path = "fleet.json"): FleetConfig` | Read, parse and validate. Throws `ConfigError`. |
| `loadConfigOrEmpty(path?): FleetConfig` | As above, or `{ repos: [] }` if the file does not exist. |
| `validateConfig(raw: unknown): FleetConfig` | Validate an already parsed object. |
| `saveConfig(path: string, config: FleetConfig): void` | Write normalized JSON. |
| `isRepoName(s: unknown): s is string` | `owner/repo` check. |
| `class ConfigError extends Error` | Validation or read failure. |

### Selection

| Signature | Description |
| --- | --- |
| `resolveTargets(config, opts?: { repos?, group? }): string[]` | Narrow the selection; always a subset of `config.repos`. |
| `class NotSelectedError extends Error` | Has `repos: string[]`; thrown for anything outside the selection. |
| `parseRepo(full: string): RepoRef` | Split `owner/repo`; throws on invalid input. |
| `listAdminRepos(client, { owner?, filter? }): Promise<AdminRepo[]>` | Repos the user administers, sorted. |
| `globToRegExp(glob: string): RegExp` | Case-insensitive `*`/`?` glob. |
| `applySelectionChange(config, change): FleetConfig` | Pure add/remove. |
| `applyChosen(config, chosen, group?): FleetConfig` | Pure replace of selection or group. |
| `selectNonInteractive(client, config, change): Promise<FleetConfig>` | Add/remove after verifying admin on added repos. |

### Operations

| Signature | Description |
| --- | --- |
| `inventory(client, targets: string[]): Promise<InventoryResult>` | Per-repo inventory plus package summary. |
| `inventoryRepo(client, full): Promise<RepoInventory>` | Single repo. |
| `analyzeWorkflow`, `extractUses`, `isUnpinned`, `hasGeneratedHeader`, `compareVersions`, `summarizePackages` | Inventory helpers. |
| `settingsDiff(client, targets, policy: SettingsPolicy \| undefined): Promise<RepoSettingsDiff[]>` | Read and diff; throws if `policy` is undefined. |
| `settingsApply(client, targets, policy, { dryRun: boolean }): Promise<ApplyResult>` | Compute and (if `!dryRun`) perform PUTs. |
| `readRepoSettings(client, full, policy)`, `diffSettings(state, policy)` | Reader and pure comparison. |
| `secretsReport(client, config, targets, { now?, maxAgeDays? }): Promise<SecretsReport>` | Staleness report. |
| `listRepoSecrets(client, full)`, `policyTargets(config, policy, targets)` | Helpers. |
| `needsAttention(row: SecretRow): boolean` | True for `stale`, `missing`, `untracked-stale`. |
| `rotateSecret(client, targets, { name, environment?, value, dryRun }): Promise<RotateResult[]>` | Seal and PUT; value never returned. |
| `sealSecret(publicKeyB64: string, value: string): Promise<string>` | libsodium sealed-box encryption, base64. |
| `writeHtmlReport(client, config, targets, out: string, { now? }?): Promise<FleetReportData>` | Build the report and write the HTML file. |
| `buildReport(client, config, targets, { now?, maxAgeDays? }?)`, `renderHtmlReport(data)`, `esc(s)` | Report building blocks. |

### Client and CLI

| Signature | Description |
| --- | --- |
| `createClient(token = tokenFromEnv()): GitHubClient` | Octokit-backed client (user agent `cikick-fleet`, `per_page: 100`). |
| `tokenFromEnv(env = process.env): string` | `GITHUB_TOKEN` or `GH_TOKEN`; throws if neither. |
| `errorStatus`, `getOrUndefined`, `errMessage` | Client helpers (`getOrUndefined` maps 404 to `undefined`). |
| `buildProgram(deps?: CliDeps): Command` | Build the commander program. |
| `main(argv?: string[]): Promise<void>` | Run it; errors are printed and set exit code 1. |
