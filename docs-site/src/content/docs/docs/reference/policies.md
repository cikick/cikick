---
title: '@cikick/policies'
description: API reference for @cikick/policies - security aspects, stock checks, deprecatedAction, fileContains and the security baseline.
---

`@cikick/policies` provides ready-made [aspects](/cikick/docs/reference/core/#aspects) (which rewrite the construct tree before synthesis) and [checks](/cikick/docs/reference/core/#checks) (which report findings after it). Concepts: [Customisation](/cikick/docs/concepts/customisation/), [Checks](/cikick/docs/concepts/checks/).

```ts title="cikick.config.ts"
import { App, Aspects, Checks } from '@cikick/core';
import { applyBaseline, deprecatedAction, fileContains, HardenRunner, ReplaceAction } from '@cikick/policies';

export default (app: App) => {
  applyBaseline(app, { timeoutMinutes: 20, permissions: { default: { contents: 'read' } } });

  Aspects.of(app).add(new HardenRunner({ egressPolicy: 'block' }));
  Aspects.of(app).add(new ReplaceAction({ from: 'actions/checkout@v3', to: 'actions/checkout@v4' }));

  Checks.of(app).add(deprecatedAction({ action: 'actions/upload-artifact', below: 'v4', enforceAfter: '2027-01-01' }));
  Checks.of(app).add(
    fileContains({
      path: 'CODEOWNERS',
      pattern: '@acme/platform',
      message: 'CODEOWNERS must include @acme/platform',
      required: true,
    }),
  );

  // ... workflows
};
```

## Aspects

Aspects implement `IAspect`. Register with `Aspects.of(scope).add(aspect)`; they are applied by `synth` before refs are resolved.

### ExplicitPermissions

Sets permissions wherever none are declared (least privilege by default).

```ts
new ExplicitPermissions(props?: ExplicitPermissionsProps)
```

| Prop      | Type                  | Default                | Description                                                                                                                   |
| --------- | --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `default` | `Permissions`         | `{ contents: 'read' }` | Permissions to apply. Either a map or `'read-all'` / `'write-all'`.                                                           |
| `level`   | `'workflow' \| 'job'` | `'workflow'`           | `workflow`: set on every workflow with `permissions === undefined`. `job`: set on every job with `permissions === undefined`. |

Each target receives its own copy of the map. Existing permissions are never changed, including an explicit `{}`.

### DefaultTimeout

```ts
new DefaultTimeout(minutes: number)
```

Sets `timeoutMinutes` on every job that has none, except jobs that call a reusable workflow (`uses` set).

### HardenRunner

Prepends a [`step-security/harden-runner`](https://github.com/step-security/harden-runner) step to jobs.

```ts
new HardenRunner(props?: HardenRunnerProps)
```

| Prop           | Type                      | Default                            | Description                                                                                     |
| -------------- | ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `egressPolicy` | `'audit' \| 'block'`      | `'audit'`                          | Sent as `with: { 'egress-policy': ... }`.                                                       |
| `action`       | `string`                  | `'step-security/harden-runner@v2'` | `owner/repo[/path]@ref` to use.                                                                 |
| `with`         | `Record<string, unknown>` | `{}`                               | Extra inputs, merged after `egress-policy` (so they can override it), e.g. `allowed-endpoints`. |

Applies to jobs that have at least one step and no `uses`. Skipped when the job's first step already uses the same `owner/repo`. The inserted step is named `Harden Runner`. Because constructs cannot be reordered, the aspect appends a step and shifts every step's props down by one; step node ids are unchanged. The `action` ref is resolved and pinned like any other.

### ReplaceAction

Replaces one action ref with another, on steps and on reusable-workflow jobs.

```ts
new ReplaceAction(props: ReplaceActionProps)
```

| Prop   | Type     | Description                                                                                                                                                      |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from` | `string` | `owner/repo[/path]@ref` to match. Matched against the original spec (`toSpec()`), so the ref must equal exactly: `actions/checkout@v3` does not match `@v3.1.0`. |
| `to`   | `string` | Replacement `owner/repo[/path]@ref`.                                                                                                                             |

Both strings are parsed with `ActionRef.of` at construction and throw if invalid. The replacement is unresolved, so it is pinned during the same synth.

## Checks

All checks are plain `Check` objects. Findings carry `path` = the workflow file (`.github/workflows/<id>.yml`) unless noted.

| Export                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Id                                | Severity | Flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requirePinnedActions`                                                                                                                                                                                                                                                                                                                                                                                                                                               | `require-pinned-actions`          | error    | Any step or job `uses` that is an `ActionRef` without a full 40-hex `sha`; a `docker://` ref without `@sha256:`; a non-local, non-docker string that was not parsed into an `ActionRef`. Local `./` refs pass. Message: `job "<id>": <spec> is not pinned to a commit sha`.                                                                                                                                                                                                                                                                                        |
| `requireExplicitPermissions`                                                                                                                                                                                                                                                                                                                                                                                                                                         | `require-explicit-permissions`    | error    | Each job without `permissions` in a workflow that has no workflow-level `permissions`. Message: `job "<id>" has no explicit permissions (and workflow declares none)`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `noPullRequestTargetCheckout`                                                                                                                                                                                                                                                                                                                                                                                                                                        | `no-pull-request-target-checkout` | error    | In workflows triggered by `pull_request_target` (string, array or object key in either `pullRequestTarget` or `pull_request_target` form), steps using `actions/checkout` whose `with.ref` or `with.repository` matches `/head\|github\.event\.pull_request\|github\.head_ref\|refs\/pull\//i`.                                                                                                                                                                                                                                                                    |
| `noScriptInjection`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `no-script-injection`             | warn     | `${{ ... }}` expressions inside a step's `run` script that reference attacker-controllable context: `github.head_ref`, issue/PR title and body, `head.ref`/`head.label`/`head.repo.default_branch`, comment, review and review-comment bodies, discussion title/body, page names, commit messages, `head_commit` message/author name/email, `github.base_ref`, workflow inputs (`inputs.*`, `github.event.inputs.*`), or any `github.event...` path ending in `title`, `body`, `head_ref`, `label` or `message`. Message suggests passing the value through `env`. |
| `noCancelInProgressDeploy`                                                                                                                                                                                                                                                                                                                                                                                                                                           | `no-cancel-in-progress-deploy`    | warn     | A deploy job (has an `environment`, runs `wrangler deploy`/`pages deploy`/`d1 migrations apply`, or uses `cloudflare/wrangler-action`) whose job or workflow `concurrency` sets `cancel-in-progress` to `true` or an expression. `false` and `github.event_name == 'pull_request'` pass.                                                                                                                                                                                                                                                                           |
| `requireTimeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `require-timeout`                 | warn     | Jobs with neither `timeoutMinutes` nor `uses`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `requirePinnedActions` runs after synth has resolved refs, so in a normal synth every remote ref already has a sha and it acts as a safety net (for example when refs were resolved incorrectly or `ActionRef` objects were created manually and bypassed resolution). The `no-script-injection` pattern is a regular expression match on the expression text, not a data-flow analysis; it can produce false positives and does not look at `env` or `with` values. |

### deprecatedAction

```ts
deprecatedAction(props: DeprecatedActionProps): Check
```

| Prop           | Type       | Default  | Description                                                                   |
| -------------- | ---------- | -------- | ----------------------------------------------------------------------------- |
| `action`       | `string`   | required | `owner/repo[/path]`, compared with `ActionRef.target`.                        |
| `below`        | `string`   | required | Refs whose major version is lower are flagged. Parsed with `/^v?(\d+)(?:[.\-] | $)/`; throws at construction if unparsable. |
| `enforceAfter` | `string`   | none     | ISO date after which a `warn` becomes `error`.                                |
| `severity`     | `Severity` | `'warn'` | Severity of findings.                                                         |

Check id: `deprecated-action:<action>`. Refs with no parsable major (branches, SHAs written as the ref) are not flagged. Each distinct ref is reported once per workflow. Message: `<owner/repo@ref> is deprecated; use <action>@<below> or newer`.

### fileContains

```ts
fileContains(props: FileContainsProps): Check
```

| Prop           | Type                                                 | Default                | Description                                                                              |
| -------------- | ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `id`           | `string`                                             | `file-contains:<path>` | Check id.                                                                                |
| `path`         | `string`                                             | required               | Repo-relative file.                                                                      |
| `pattern`      | `RegExp \| string \| ((content: string) => boolean)` | required               | RegExp (the `g` flag is ignored), substring, or predicate that the content must satisfy. |
| `message`      | `string`                                             | required               | Finding message.                                                                         |
| `severity`     | `Severity`                                           | `'warn'`               |                                                                                          |
| `enforceAfter` | `string`                                             | none                   | ISO date upgrading `warn` to `error`.                                                    |
| `required`     | `boolean`                                            | `false`                | Also report when the file is missing. When false, a missing file yields no finding.      |

The finding's `path` is the checked file.

## Baseline

```ts
interface BaselineOptions {
  timeoutMinutes?: number; // default 30
  permissions?: ConstructorParameters<typeof ExplicitPermissions>[0];
}
interface Baseline {
  aspects: IAspect[];
  checks: Check[];
}
function securityBaseline(opts?: BaselineOptions): Baseline;
function applyBaseline(app: App, opts?: BaselineOptions): Baseline;
```

`securityBaseline` builds, without registering:

- Aspects: `new ExplicitPermissions(opts.permissions ?? { default: { contents: 'read' } })` and `new DefaultTimeout(opts.timeoutMinutes ?? 30)`.
- Checks: `requirePinnedActions`, `requireExplicitPermissions`, `noPullRequestTargetCheckout`, `noScriptInjection`, `noCancelInProgressDeploy`, `requireTimeout`.

`applyBaseline` calls it and registers the aspects and checks on `app` via `Aspects.of(app)` / `Checks.of(app)`, returning the `Baseline`.

:::caution
`BaselineOptions.permissions` is typed as `ExplicitPermissionsProps` (`{ default?: Permissions; level?: 'workflow' | 'job' }`), not as `Permissions`. Pass `{ default: { contents: 'read' } }`, not `{ contents: 'read' }`. The doc comment in the source ("Default permissions. Default `{ contents: 'read' }`") reads as if a bare permissions map were accepted; TypeScript rejects it for object literals, and in plain JavaScript a bare map would be ignored (the `default` key is absent, so the built-in `{ contents: 'read' }` applies regardless of what you passed).
:::
