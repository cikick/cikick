---
title: Secrets
description: Declaring secrets in code with secret(), the manifest printed by `cikick secrets`, and exactly how (and how little) fleet policies connect to it.
---

A workflow that reads `${{ secrets.NPM_TOKEN }}` has a dependency that is invisible in the repo: nothing says who provisions it, what it is for, or how often it should rotate. `secret()` keeps the expression and the declaration in one place, so the config can answer "which secrets does this repo need?" without anyone reading YAML.

:::note
cikick never reads, stores or transmits secret values from the config side. `secret()` produces a string, and the manifest contains names and metadata only. Values only appear in one place: `cikick-fleet secrets rotate`, where you supply a value for it to encrypt and upload. See [Fleet](/cikick/docs/concepts/fleet/).
:::

## `secret(scope, name, opts)`

```ts
import { secret } from '@cikick/core';

job.addStep({
  name: 'Publish',
  run: 'npm publish --provenance',
  env: { NODE_AUTH_TOKEN: secret(this, 'NPM_TOKEN', { maxAgeDays: 90, provider: 'npm' }) },
});
```

- Returns the string `${{ secrets.NPM_TOKEN }}`, ready to use in `env`, `with`, or `run`.
- Registers a `SecretDecl` construct on the **app root** (found via `scope.node.root`), so it does not matter which construct you pass as `scope`.
- `opts` is `{ scope?, environment?, maxAgeDays?, provider?, description? }`:

| Option        | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `scope`       | `'repo'` (default), `'env'` or `'org'`.                   |
| `environment` | Environment name for `'env'` secrets.                     |
| `maxAgeDays`  | Intended maximum age before rotation.                     |
| `provider`    | Free text: who issues the credential (`npm`, `aws`, ...). |
| `description` | Free text.                                                |

Core does not validate combinations: `scope: 'env'` without `environment` is accepted.

### Deduplication

A declaration is identified by `(name, scope, environment)`. Calling `secret()` again with the same triple reuses the existing declaration instead of creating a new one, and **fills in only the fields that are still unset**: the first value of `maxAgeDays`, `provider` and `description` wins; later calls can add a missing field but never overwrite one. The expression is returned every time, so use the helper at each point of use and declare the metadata once.

## The manifest

```bash
npx cikick secrets          # table
npx cikick secrets --json   # machine-readable
```

The command loads your config (it does not synth, resolve or write anything) and prints all declarations sorted by name, scope and environment. Table columns are `NAME  SCOPE  ENVIRONMENT  MAX AGE (d)  PROVIDER` with `-` for unset values; `--json` also includes `description`. With nothing declared it prints `No secrets declared.`

For the example consumer (an npm token from the package, plus an environment secret declared in the repo config):

```json
[
  { "name": "DEPLOY_KEY", "scope": "env", "environment": "production", "maxAgeDays": 30 },
  { "name": "NPM_TOKEN", "scope": "repo", "maxAgeDays": 90, "provider": "npm" }
]
```

Declaring a deploy key in the same config as the workflow that uses it:

```ts
env: { DEPLOY_KEY: secret(app, 'DEPLOY_KEY', { scope: 'env', environment: 'production', maxAgeDays: 30 }) },
```

## How fleet relates to this

The manifest and fleet policies are **separate** things, and nothing connects them automatically:

- `cikick-fleet` does not read `cikick secrets` output, `SecretDecl`s, or any repo's `cikick.config.ts`. It never runs your config.
- Age tracking in fleet comes from `secretPolicies` in `fleet.json`, each with its own `name`, `scope`, optional `environment`, and `maxAgeDays`. `cikick-fleet secrets report` compares GitHub's `updated_at` for each secret against those policies. See [fleet reference](/cikick/docs/reference/fleet-config/).
- A secret that exists in the repo but matches no policy is reported as `untracked` (or `untracked-stale` past a default age, 180 days unless `--max-age` is given).
- A secret that a policy names but the repo lacks is reported as `missing`. "Missing" means missing relative to `fleet.json`, not relative to what the repo's workflows reference.

So `maxAgeDays` in `secret()` is documentation and a machine-readable manifest today. If you want fleet to enforce the same limit, repeat it in `secretPolicies`. You can generate `fleet.json` policies from the `--json` output with your own script, since the shapes are close (`name`, `scope`, `environment`, `maxAgeDays`).

:::caution
The fleet policy accepts only `repo` and `env` scopes. `scope: 'org'` can be declared with `secret()` and shows in the manifest, but fleet cannot report on or rotate organisation secrets. See [Fleet](/cikick/docs/concepts/fleet/).
:::

## Edge cases

- Secrets inside reusable-workflow calls: `Job.secrets` accepts a map or `'inherit'`; use `secret()` for the map values so they are declared.
- Using `secret()` in a shared package (as `NodeCi` does for `NPM_TOKEN`) means consumers inherit the declaration automatically, since it registers on whatever app the package is used in. Consumer config can call `secret()` with the same name and scope afterwards to fill in a field the package left unset.
- `cikick secrets` prints declarations from the whole tree, whether or not the workflow using the secret is ever synthesised.
