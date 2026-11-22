---
title: cikick CLI
description: Reference for the cikick binary - synth, check, lock, update, migrate, secrets and init, with options, defaults, exit codes and environment variables.
---

The `cikick` binary is provided by `@cikick/cli`. It loads the repository's `cikick.config.ts`, synthesizes workflows and `cikick.lock.json`, verifies drift, and runs package migrations. Fleet operations live in a separate binary: see [cikick-fleet CLI](/cikick/docs/reference/cikick-fleet-cli/).

```text
cikick <command> [options]
```

## Commands

| Command | Purpose | Writes | Fails (exit 1) when |
| --- | --- | --- | --- |
| `synth` | Synthesize workflows, managed files and the lockfile | Generated files, `cikick.lock.json` | Any finding has severity `error`; frozen lock is missing entries; config or resolver error |
| `check` | Verify generated files are up to date (frozen) | Nothing | Drift detected, any `error` finding, or lock is missing entries |
| `lock` | Resolve action refs and update the lockfile only | `cikick.lock.json` | Any `error` finding; resolver error |
| `update` | Run package migrations, then synth | Config (via migrations), generated files, lockfile | Synth has `error` findings; a migration throws |
| `migrate <pkg>` | Run one package's migrations explicitly | Whatever the migrations write | Package not installed; invalid semver; a migration throws |
| `secrets` | Print the declared secrets manifest | Nothing | Config cannot be loaded |
| `init` | Write a starter `cikick.config.ts` | `cikick.config.ts` | Directory is not writable |

Usage errors reported by the argument parser (unknown command or option, missing required option) also exit with a non-zero status. Uncaught errors are printed as the bare error message to stderr and exit with code 1.

## Shared option

Every command accepts:

| Option | Default | Description |
| --- | --- | --- |
| `--dir <repo>` | `process.cwd()` | Repository directory. Config, lockfile, `package.json` and outputs are all resolved relative to it. |

## Configuration discovery

The repository config is the first existing file among `cikick.config.ts`, `cikick.config.mts`, `cikick.config.js`, `cikick.config.mjs` in `--dir`. It is loaded with jiti, uncached. The default export must be either an `App` or a function `(app: App) => void | Promise<void>`. If none exists the command fails with `No cikick.config.ts (or .js/.mjs) found in <dir>. Run \`npx cikick init\`.`

For function exports, cikick creates `new App({ outdir: <dir> })`, registers any checks exported by installed cikick packages (see below), then calls your function.

### cikick packages

Dependencies and devDependencies listed in the repo's `package.json` are inspected. An installed package whose own `package.json` has a string `cikick` field is a cikick package; that field names a module exporting `{ migrations, checks? }` (see `CikickPackageExports` in [@cikick/core](/cikick/docs/reference/core/)). Its `checks` are added to the app before your config runs; its `migrations` are used by `update` and `migrate`. Installed versions are recorded in `cikick.lock.json` under `packages`. See [Migrations](/cikick/docs/concepts/migrations/).

## Resolver order

Action refs that are not already full 40-character SHAs and not already in the lockfile are resolved by a `FallbackResolver`:

1. `GitResolver`: runs `git ls-remote https://github.com/<owner>/<repo>` for `refs/tags/<ref>`, its peeled `^{}` form, and `refs/heads/<ref>` (30 s timeout; needs `git` on `PATH`; no token needed). Tags win over branches; annotated tags are dereferenced to the commit.
2. `GitHubResolver`: on any failure of the first, calls `GET https://api.github.com/repos/<owner>/<repo>/commits/<ref>`, sending `Authorization: Bearer $GITHUB_TOKEN` when `GITHUB_TOKEN` is set and non-empty.

If both fail, the last error (from the GitHub API) is thrown. `synth --frozen` and `check` use no network resolver at all: a ref missing from the lockfile raises `FrozenLockError` before any resolution. `synth` and `lock` without `--frozen` use the order above. See [Lockfile and pinning](/cikick/docs/concepts/lockfile-and-pinning/).

## Environment variables

| Variable | Used by | Effect |
| --- | --- | --- |
| `GITHUB_TOKEN` | `synth`, `lock`, `update` (non-frozen) | Bearer token for the GitHub API fallback resolver. Optional; unauthenticated requests are rate-limited. Not used by `GitResolver`. |

No other environment variables are read by `cikick`.

## synth

```text
cikick synth [--dir <repo>] [--frozen] [--refresh]
```

| Option | Default | Description |
| --- | --- | --- |
| `--dir <repo>` | cwd | Repository directory. |
| `--frozen` | off | Fail if a non-SHA action ref is missing from `cikick.lock.json`. No resolver is used. |
| `--refresh` | off | Ignore existing lock entries and re-resolve every non-SHA ref. Combined with `--frozen` this always fails if any non-SHA ref exists. |

Reads: config, installed cikick packages, `cikick.lock.json` (empty lockfile if absent), and `patchFile`s of merged managed files. Writes: every synthesized file (workflows under `.github/workflows/<id>.yml` and [managed files](/cikick/docs/concepts/managed-files/)) and `cikick.lock.json`. `seeded` files that already exist are kept. Files are written even if findings contain errors; the exit code reflects the findings.

Output lines, in order: `wrote <path>` for each written file (sorted by path) then `wrote cikick.lock.json`; `kept  <path> (seeded)` for each preserved seeded file; then one line per [finding](/cikick/docs/concepts/checks/).

Finding format: `<SEVERITY padded to 5> [<checkId>] <path>: <message>`.

Exit code: `1` if any finding has severity `error`, otherwise `0`. A `FrozenLockError` or resolver error is printed and exits `1`.

```bash
npx cikick synth
```

```text
wrote .github/workflows/ci.yml
wrote cikick.lock.json
WARN  [require-timeout] .github/workflows/ci.yml: job "test" has no timeout-minutes
```

## check

```text
cikick check [--dir <repo>]
```

Synthesizes in memory with `frozen: true` and compares against disk. Writes nothing. Intended for CI: see [CI check guide](/cikick/docs/guides/ci-check/).

Drift means a generated file is missing or differs byte-for-byte from the synthesized content (`seeded` files drift only when missing), or `cikick.lock.json` differs from the expected serialization (including the recorded `packages` versions). A missing lockfile counts as drift only if actions need locking.

Output: `drift: <path>` for each drifted path, then findings in the same format as `synth`. If any drift exists, stderr also gets `Generated files are out of date. Run \`npx cikick synth\` and commit.` Nothing is printed on a clean run.

Exit code: `1` if there is drift or any `error` finding (warnings alone pass); a ref missing from the lock prints the `FrozenLockError` message and exits `1`; otherwise `0`.

```text
drift: .github/workflows/ci.yml
drift: cikick.lock.json
Generated files are out of date. Run `npx cikick synth` and commit.
```

## lock

```text
cikick lock [--dir <repo>] [--refresh]
```

| Option | Default | Description |
| --- | --- | --- |
| `--dir <repo>` | cwd | Repository directory. |
| `--refresh` | off | Re-resolve every non-SHA action ref. |

Runs a non-frozen synth in memory and writes only `cikick.lock.json`; workflow files are not touched. Output: `wrote cikick.lock.json`. Findings are not printed by this command, but an `error` finding still sets exit code `1`.

## update

```text
cikick update [--dir <repo>] [--dry-run]
```

| Option | Default | Description |
| --- | --- | --- |
| `--dir <repo>` | cwd | Repository directory. |
| `--dry-run` | off | List the migrations that would run; change nothing. |

For each discovered cikick package, compares the version recorded in the lockfile (`packages`) with the installed version:

- Not in the lockfile: logs `<pkg>@<version>: first adoption, recording version (no migrations)`.
- Installed older than locked: logs `<pkg>: installed <v> is older than locked <l>; skipping migrations`.
- Different version: logs `<pkg>: <from> -> <to>` and plans every migration with `from < migration.version <= to`, ascending.

Without `--dry-run`, planned migrations run in order (log: `migrate <pkg>@<version>: <description>`); the ts-morph project for the config is saved after each, then a full `synth` runs (non-frozen, resolver order above) which records the new package versions in the lockfile. With `--dry-run`, logs `would run <pkg>@<version>: <description>` per migration, or `no migrations to run`, and exits `0`.

Exit code: `1` if the final synth has `error` findings or a migration throws; otherwise `0`. See [Migrations](/cikick/docs/concepts/migrations/) and the [Renovate guide](/cikick/docs/guides/renovate/).

```text
@your-org/wf-node: 1.2.0 -> 1.3.0
migrate @your-org/wf-node@1.3.0: rename input node-version to nodeVersion
wrote .github/workflows/ci.yml
wrote cikick.lock.json
```

## migrate

```text
cikick migrate <pkg> --from <version> [--to <version>] [--dir <repo>]
```

| Option | Default | Description |
| --- | --- | --- |
| `<pkg>` | required | Name of an installed cikick package. |
| `--from <version>` | required | Version migrating from (exclusive lower bound). |
| `--to <version>` | installed version | Version migrating to (inclusive upper bound). |
| `--dir <repo>` | cwd | Repository directory. |

Runs `pkg`'s migrations with `from < version <= to`, skipping everything if `from >= to`. Logs `migrate <pkg>@<version>: <description>` per migration. It does not run `synth` and does not update the lockfile; run `cikick synth` afterwards. Errors: `<pkg> is not an installed cikick package of <dir>`; `Invalid semver "<v>"`.

```bash
npx cikick migrate @your-org/wf-node --from 1.2.0 --to 1.3.0
```

## secrets

```text
cikick secrets [--dir <repo>] [--json]
```

| Option | Default | Description |
| --- | --- | --- |
| `--dir <repo>` | cwd | Repository directory. |
| `--json` | off | Print the manifest as indented JSON (`SecretManifestEntry[]`). |

Loads the config and prints every secret declared through `secret()`, sorted by name, scope, environment. Prints `No secrets declared.` when empty. This command only reads declarations; it does not contact GitHub (see [Secrets](/cikick/docs/concepts/secrets/) and `cikick-fleet secrets report`).

```text
NAME          SCOPE  ENVIRONMENT  MAX AGE (d)  PROVIDER
AWS_ROLE_ARN  env    production   -            -
NPM_TOKEN     repo   -            90           npm
```

## init

```text
cikick init [--dir <repo>]
```

Writes a starter `cikick.config.ts` (a `ci` workflow with checkout and an echo step) into `--dir`. If `cikick.config.ts` already exists it prints `cikick.config.ts already exists, leaving it untouched` and does not overwrite (only that exact filename is checked). Otherwise prints `wrote cikick.config.ts`. In both cases it then prints a `package.json` scripts hint (`cikick:synth`, `cikick:check`) and a sample `renovate.json` that runs `npx cikick update` as a post-upgrade task. Exit code `0`.
