---
title: Migrations
description: How shared packages ship codemods, how `cikick update` decides which to run, and a walkthrough of the real NodeCi 2.0.0 node-to-nodeVersion migration.
---

When a shared package renames a prop or restructures its output, every consuming repo breaks until someone edits its config. With a hundred repos that is a hundred manual edits. Migrations let the package author write the edit once, as code; Renovate bumps the version, and `cikick update` applies the migration in each repo as part of the same pull request.

## Authoring: what a package ships

```ts
interface Migration {
  version: string;           // semver of the package release that introduced it
  description: string;
  run(ctx: MigrationContext): Promise<void>;
}

interface MigrationContext {
  repoDir: string;
  readFile(path: string): string | undefined;   // relative to repoDir
  writeFile(path: string, content: string): void; // creates directories
  deleteFile(path: string): void;               // no-op if absent
  project: Project;                             // ts-morph, containing the cikick config file
  log(msg: string): void;
}
```

The package points its `cikick` field at a module that exports `{ migrations, checks? }`:

```json title="package.json"
{
  "name": "@acme/wf-node-ci",
  "version": "2.0.0",
  "cikick": "./dist/cikick.js"
}
```

```ts title="src/cikick.ts"
export const migrations: Migration[] = [ /* ... */ ];
export const checks: Check[] = [ /* optional, see Checks */ ];
export default { migrations, checks };
```

The CLI accepts the module with named exports or a default export. `ctx.project` is a ts-morph project that has only the repo's `cikick.config.ts` loaded; after each migration the CLI saves it and reloads its source files from disk, so edits through `project` and through `writeFile` both take effect. A migration may also call `ctx.project.save()` itself.

## `cikick update`

`cikick update` (see the [CLI reference](/cikick/docs/reference/cikick-cli/)) does this:

1. Discover cikick packages: dependencies and devDependencies of the repo's `package.json` that are installed and whose `package.json` has a `cikick` field (module resolved by walking up `node_modules`).
2. For each, compare `lock.packages[name]` (the version at last synth, see [Lockfile](/cikick/docs/concepts/lockfile-and-pinning/)) with the installed version:
   - **Not in the lock** (first adoption): log `first adoption, recording version (no migrations)`. Nothing runs; the installed version will be recorded.
   - **Locked version is newer than installed** (a downgrade): log `installed X is older than locked Y; skipping migrations`. Nothing runs.
   - **Equal**: nothing to do.
   - **Locked is older**: select migrations with `from < migration.version <= to`, sorted ascending by semver (ties keep declaration order). `from` is the locked version, `to` the installed one. A migration with an invalid semver throws.
3. With `--dry-run`: print `would run <pkg>@<version>: <description>` for each planned migration (or `no migrations to run`) and stop. Nothing is written, including the lock.
4. Otherwise run the planned migrations in order, then run a normal `synth`. That synth regenerates workflows, resolves any new action refs, runs checks, and writes the lockfile with the new package versions. Exit code is 1 if the synth has error findings.

The lock's `packages` map is merged: entries for packages that are no longer installed stay until you remove them by hand.

### Running one package explicitly

```bash
npx cikick migrate @acme/wf-node-ci --from 1.4.0            # to the installed version
npx cikick migrate @acme/wf-node-ci --from 1.4.0 --to 2.0.0
```

`migrate` uses the same selection rule but only runs that package's migrations. It does not synth and does not touch the lockfile; run `cikick synth` afterwards. It errors if the package is not an installed cikick package of the repo. Use it to replay a migration, or when the lock has no record of the old version.

### Writing migrations safely

- If a migration throws, `update` stops before synth and the lockfile is not updated, but earlier migrations in the run may already have changed files. Write migrations to be safe to run twice (check before editing, as the example does).
- Match what you rewrite narrowly, and prefer AST edits over text replacement; ts-morph preserves formatting and comments.
- Never delete a file you cannot prove is generated. The example checks the generated header first.

## Walkthrough: `@acme/wf-node-ci` 2.0.0

The 2.0.0 release renamed the `NodeCi` prop `node` to `nodeVersion`. From its `CHANGELOG.md`: "`npx cikick update` runs the `2.0.0` migration automatically". The migration does two things.

**1. Rename the prop** in every `new NodeCi(scope, id, { node: ... })` with ts-morph (property assignments are renamed, `{ node }` shorthand becomes `nodeVersion: node`):

```ts
for (const call of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
  if (call.getExpression().getText() !== 'NodeCi') continue;
  /* ...find the object literal, rename `node` to `nodeVersion` */
}
```

**2. Delete the legacy workflow** `.github/workflows/node.yml`, only if it starts with the cikick generated header:

```ts
const content = ctx.readFile(legacy);
if (content !== undefined && content.startsWith(GENERATED_HEADER)) {
  ctx.deleteFile(legacy);
} else if (content !== undefined) {
  ctx.log(`kept ${legacy} (not generated by cikick)`);
}
```

In a consumer repo whose lock says `"@acme/wf-node-ci": "1.x"` and whose config says:

```ts
const ci = new NodeCi(app, 'node', { node: 22, packageManager: 'pnpm' });
```

Renovate bumps the dependency to 2.0.0 and runs `npx cikick update` (see [Renovate guide](/cikick/docs/guides/renovate/)). Illustrative output:

```text
@acme/wf-node-ci: 1.4.0 -> 2.0.0
migrate @acme/wf-node-ci@2.0.0: Rename NodeCi prop `node` to `nodeVersion`; remove legacy cikick-generated .github/workflows/node.yml
renamed 1 `node` prop(s) to `nodeVersion`
deleted legacy .github/workflows/node.yml
wrote .github/workflows/ci.yml
...
wrote cikick.lock.json
```

The config is now `new NodeCi(app, 'node', { nodeVersion: 22, packageManager: 'pnpm' })`, the lock records `2.0.0`, and the PR contains the config change, regenerated YAML and lock together.

### Limits of this particular migration

It matches the constructor by its source text `NodeCi`, so an aliased import (`import { NodeCi as Ci }`) is not rewritten, and a `node` prop passed through a variable rather than an object literal is not found. Package authors should say so in the changelog, and ship a [check](/cikick/docs/concepts/checks/) with `enforceAfter` for cases a codemod cannot reach.
