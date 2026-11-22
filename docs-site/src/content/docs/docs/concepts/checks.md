---
title: Checks
description: Checks report policy violations over the construct tree and repo files, with severities, date-based escalation (enforceAfter), and the stock checks in @cikick/policies.
---

Some rules cannot be fixed automatically: a Node version that is out of support, a `pull_request_target` workflow that checks out PR code, a deprecated action. A check reports these as findings. Because a check can start as a warning and become an error on a date, a platform team can announce a deadline in code instead of in a wiki page, and `cikick check` enforces it in CI when the date passes.

## The API

```ts
type Severity = 'info' | 'warn' | 'error';

interface Check {
  id: string;
  severity: Severity;
  enforceAfter?: string; // ISO date
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

interface CheckContext {
  app: App; // the construct tree
  repoDir: string;
  readFile(path: string): string | undefined; // relative to repoDir; undefined if absent
  settings?: RepoSettings;
  files?: SynthFile[]; // files produced by this synth
}

interface Finding {
  checkId: string;
  severity: Severity;
  message: string;
  path?: string;
  fix?: () => void;
}
```

Register a check on any construct with `Checks.of(scope).add(check)`. During synth, after aspects have run and files have been rendered, every node's registered checks are run in tree order, and each returns zero or more findings. A finding without a `checkId` gets the check's `id`.

:::note
`Finding.fix` exists in the type, but nothing in the CLI calls it today. Treat it as reserved.
:::

## Severity and `enforceAfter`

Each finding carries a severity; if the finding does not set one, the check's severity is used. The effective severity is then computed from `enforceAfter`:

- If the severity is `warn`, `enforceAfter` is set, and the current time is later than that ISO date, the finding becomes `error`.
- Anything else is unchanged. `info` and `error` findings never change, and a check with no `enforceAfter` never escalates.

Escalation is evaluated against the clock on every run, so no commit is needed when the deadline passes: the same repo starts failing `cikick check` the next time it runs. The date is compared as `new Date(enforceAfter)`; an ISO date such as `2027-03-01` means midnight UTC.

## How packages ship checks

A package's `package.json` has a `cikick` field naming a module; the module exports `{ migrations, checks? }` (the same module that ships [migrations](/cikick/docs/concepts/migrations/)). The CLI finds every dependency or devDependency of the repo that has this field and registers its `checks` on the app **before** your config runs. Consumers do nothing to opt in, and checks from a package apply even if your config does not construct anything from it.

This is the check from `@acme/wf-node-ci`:

```ts title="examples/wf-node-ci/src/cikick.ts"
export const nvmrcCheck: Check = {
  id: '@acme/wf-node-ci:nvmrc-min-node',
  severity: 'warn',
  enforceAfter: '2027-03-01',
  run(ctx) {
    const c = ctx.readFile('.nvmrc');
    if (c === undefined) return [];
    const major = parseInt(c.trim().replace(/^v/, ''), 10);
    if (Number.isNaN(major) || major >= 20) return [];
    return [
      {
        checkId: '@acme/wf-node-ci:nvmrc-min-node',
        severity: 'warn',
        path: '.nvmrc',
        message: `Node ${major} is end-of-life; set nodeVersion >= 20 in NodeCi`,
      },
    ];
  },
};

export const checks: Check[] = [nvmrcCheck];
```

Before 2027-03-01 a repo with `.nvmrc` below 20 sees `WARN  [@acme/wf-node-ci:nvmrc-min-node] .nvmrc: ...` and CI passes. After it, the same finding prints as `ERROR` and `cikick check` exits 1. Convention: prefix ids with the package name so findings are traceable.

## Stock checks in `@cikick/policies`

| Id                                | Severity | What it flags                                                                                                                                                                                                                                     |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require-pinned-actions`          | error    | A job or step `uses` that is not resolved to a commit SHA after synth, a `docker://` image without an `@sha256:` digest, or a malformed reference. Remote refs are pinned by synth itself, so in practice this catches un-digested Docker images. |
| `require-explicit-permissions`    | error    | A job with no `permissions` when the workflow declares none either.                                                                                                                                                                               |
| `no-pull-request-target-checkout` | error    | A `pull_request_target` workflow whose `actions/checkout` step's `ref`/`repository` points at PR head code (matches `head`, `github.event.pull_request`, `github.head_ref`, `refs/pull/`).                                                        |
| `no-script-injection`             | warn     | An attacker-controllable expression (issue/PR title or body, branch names, commit messages, and similar) interpolated directly into a `run:` script. The message suggests passing it through `env`.                                               |
| `require-timeout`                 | warn     | A job without `timeout-minutes` (reusable-workflow calls excluded).                                                                                                                                                                               |

Check factories:

```ts
import { deprecatedAction, fileContains } from '@cikick/policies';

// id: deprecated-action:actions/upload-artifact, severity warn unless overridden
Checks.of(app).add(deprecatedAction({ action: 'actions/upload-artifact', below: 'v4', enforceAfter: '2027-01-31' }));

// id: file-contains:.nvmrc unless `id` is given
Checks.of(app).add(
  fileContains({
    path: '.nvmrc',
    pattern: /^(2[0-9]|[3-9][0-9])/,
    message: '.nvmrc should be Node 20 or newer',
    enforceAfter: '2027-03-01',
  }),
);
```

- `deprecatedAction({ action, below, enforceAfter?, severity? })` flags remote refs of `action` (`owner/repo[/path]`) whose major version is lower than `below`. Refs without a parsable major (a branch name, a SHA) are ignored. Each distinct ref is reported once per workflow. `below` must parse (`v4`, `4`) or the factory throws.
- `fileContains({ path, pattern, message, severity?, enforceAfter?, required?, id? })` reads a repo file; `pattern` is a RegExp, a substring, or a predicate `(content) => boolean`. A missing file is ignored unless `required: true`.

### `securityBaseline` and `applyBaseline`

```ts
import { applyBaseline } from '@cikick/policies';

applyBaseline(app, { timeoutMinutes: 30, permissions: { default: { contents: 'read' } } });
```

`applyBaseline(app, opts?)` registers, on the app, the aspects `ExplicitPermissions` (default `contents: read`) and `DefaultTimeout` (default 30 minutes), plus the five stock checks above. `securityBaseline(opts)` returns `{ aspects, checks }` without registering them, if you want to pick pieces. See [Customisation](/cikick/docs/concepts/customisation/) for the aspects.

Because the aspects fix missing permissions and timeouts before checks run, `require-explicit-permissions` and `require-timeout` rarely fire under the baseline; they matter when someone opts out of the aspect or sets the value through an override.

## How `cikick check` exits

`cikick check` runs a frozen synth in memory (no network resolution), then compares generated files and the lockfile to the disk. It prints `drift: <path>` for each mismatch and each finding as `SEVERITY [check-id] path: message`. It exits 1 if there is any drift **or** any finding with effective severity `error`. `warn` and `info` findings are printed but do not fail the run. `cikick synth` also exits 1 on error findings, after writing files.

See the [CLI reference](/cikick/docs/reference/cikick-cli/), the [policies reference](/cikick/docs/reference/policies/) and the [CI check guide](/cikick/docs/guides/ci-check/).
