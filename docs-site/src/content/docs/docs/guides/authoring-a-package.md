---
title: Authoring a shared package
description: Build an npm package of reusable workflow constructs with managed files, secrets, migrations and checks, based on the wf-node-ci example.
---

You will build an npm package that exposes a typed workflow construct to many repositories, and ship a breaking change to it together with an automatic migration and a deprecation check. Everything here mirrors `examples/wf-node-ci` in the cikick repository (`@acme/wf-node-ci`).

## Package layout

```text
wf-node-ci/
  package.json
  tsconfig.json
  CHANGELOG.md
  src/
    index.ts      # constructs consumers import
    cikick.ts     # { migrations, checks } that the cikick CLI loads
  test/
    node-ci.test.ts
```

```json title="package.json"
{
  "name": "@acme/wf-node-ci",
  "version": "2.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "cikick": "./dist/cikick.js",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist", "CHANGELOG.md"],
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": { "@cikick/core": "^0.1.0", "constructs": "^10.8.1", "ts-morph": "^28.0.0" }
}
```

(The example package sets `"private": true` and uses `workspace:*` for `@cikick/core` because it lives in the monorepo; a package you publish should not be private and needs real version ranges. Whether `@cikick/core` is on the registry is for you to verify.)

What matters:

- **`cikick` field** points at the built module that exports `{ migrations, checks }`. The CLI imports it from the consumer's `node_modules` when it runs `synth`, `check` and `update`. If the field is missing or not a string, the package is invisible to cikick.
- **`dependencies`** on `@cikick/core` (constructs, `ManagedFile`, `secret`, migration and check types), `constructs` (base class) and `ts-morph` (used by migrations).
- **`files`** must include `dist` (and `CHANGELOG.md`, by convention).
- The `cikick` module must be built before publishing: `npm run build`.

## 1. Write a construct with typed props

A construct is a class extending `Construct` from `constructs`. Props are a plain interface, so renamed or removed props fail to compile for consumers.

```ts title="src/index.ts"
import { ManagedFile, secret, Workflow, type Job, type StepProps, type Workflow as WorkflowT } from '@cikick/core';
import { Construct } from 'constructs';

export interface NodeCiProps {
  /** Node.js major version. Default 22. */
  nodeVersion?: number;
  packageManager?: 'npm' | 'pnpm';
  /** Test command. Default `<pm> test`. */
  test?: string;
  /** Lint command, or `false` to skip. Default `<pm> run lint`. */
  lint?: string | false;
  /** Add a tag-triggered npm release job. */
  release?: { npmTokenSecret?: string };
  /** Extra steps appended to the test job. */
  extraSteps?: StepProps[];
}

export class NodeCi extends Construct {
  readonly workflow: WorkflowT;
  readonly buildJob: Job;
  /** Escape hatch: the test job. */
  readonly testJob: Job;
  readonly releaseJob?: Job;
  readonly nodeVersion: number;

  constructor(scope: Construct, id: string, props: NodeCiProps = {}) {
    super(scope, id);
    const nodeVersion = (this.nodeVersion = props.nodeVersion ?? 22);
    const pm = props.packageManager ?? 'npm';
    // ... (see below)
  }
}
```

Key points from the real implementation:

- The workflow is created *inside* the construct: `new Workflow(this, 'ci', { ... })`. The file name comes from the workflow's own id (`ci` gives `.github/workflows/ci.yml`), not from the id the consumer passes to `NodeCi`.
- Steps use ordinary action refs such as `actions/checkout@v4`; cikick pins them in the consumer's lockfile.
- Every job is added with `workflow.addJob(id, props)` and steps with `job.addStep({...})`.

```ts
this.workflow = new Workflow(this, 'ci', {
  name: 'CI',
  on: { push: { branches: ['main'], tags: props.release ? ['v*'] : undefined }, pullRequest: {} },
  concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', cancelInProgress: true },
});

this.buildJob = this.workflow.addJob('build', { runsOn: 'ubuntu-latest' });
setup(this.buildJob);   // checkout, (pnpm/action-setup), setup-node, install
// ... lint + build steps

this.testJob = this.workflow.addJob('test', { runsOn: 'ubuntu-latest', needs: this.buildJob });
setup(this.testJob);
this.testJob.addStep({ name: 'Test', run: props.test ?? (pm === 'npm' ? 'npm test' : 'pnpm test') });
for (const s of props.extraSteps ?? []) this.testJob.addStep(s);
```

## 2. Expose escape hatches

Consumers will always need something the props do not cover. Expose the pieces they are likely to touch as public `readonly` members: `workflow`, `buildJob`, `testJob`, `releaseJob`. With those a consumer can:

```ts
ci.testJob.addStep({ name: 'E2E', run: 'pnpm e2e' });          // add a step
ci.testJob.addOverride('runs-on', 'ubuntu-24.04');              // set any YAML path
ci.buildJob.props.runsOn = ['self-hosted', 'linux'];            // mutate typed props
ci.workflow.addOverride('concurrency.cancel-in-progress', false);
```

`addOverride(path, value)` sets a dotted path in the rendered YAML object (`addDeletionOverride(path)` deletes one). See [Customisation](/cikick/docs/concepts/customisation/). Treat exposed members as public API: renaming `testJob` is a breaking change.

## 3. Ship managed files

Packages can also own repository files via `ManagedFile` (see [Managed files](/cikick/docs/concepts/managed-files/)). `NodeCi` ships two:

```ts
new ManagedFile(this, 'nvmrc', { path: '.nvmrc', mode: 'managed', format: 'text', content: `${nodeVersion}\n` });

new ManagedFile(this, 'renovate', {
  path: 'renovate.json',
  mode: 'merged',
  patchFile: 'renovate.patch.json',
  content: {
    $schema: 'https://docs.renovatebot.com/renovate-schema.json',
    extends: ['config:recommended'],
    'github-actions': { enabled: false }, // cikick.lock.json owns action pins
    packageRules: [
      {
        matchPackageNames: ['@acme/wf-node-ci', '/^@cikick\\//'],
        groupName: 'cikick',
        postUpgradeTasks: { commands: ['npx cikick update'], fileFilters: ['.github/**', 'cikick.lock.json', 'renovate.json', '.nvmrc'], executionMode: 'branch' },
      },
    ],
  },
});
```

The three modes:

- `managed`: overwritten on every synth and drift-checked.
- `seeded`: written once; if the file exists it is kept, and `check` only reports it when missing.
- `merged`: `content` is deep-merged with a consumer-owned `patchFile` (objects merge recursively, arrays and scalars are replaced, `null` deletes a key). Requires `format` `json` or `yaml`.

`format` is inferred from the extension when omitted. Only YAML output (other than `seeded`) gets the generated header; JSON and text files do not.

:::caution
In `merged` mode arrays are *replaced*, not concatenated. A consumer patch that sets `packageRules` replaces the package's whole `packageRules`, including the `postUpgradeTasks` rule. Document this to consumers, and tell them to edit `renovate.patch.json`, never `renovate.json`.
:::

## 4. Declare secrets

Use `secret(scope, name, opts)` wherever a workflow needs a secret. It returns the expression `${{ secrets.NAME }}` and registers a declaration that `cikick secrets` and `cikick-fleet` read.

```ts
job.addStep({
  name: 'Publish',
  run: pm === 'pnpm' ? 'pnpm publish --provenance --no-git-checks' : 'npm publish --provenance',
  env: { NODE_AUTH_TOKEN: secret(this, props.release.npmTokenSecret ?? 'NPM_TOKEN', { maxAgeDays: 90, provider: 'npm' }) },
});
```

Options: `scope` (`'repo'` default, `'env'`, `'org'`), `environment` (for `env`), `maxAgeDays`, `provider`, `description`. Declaring the same `(name, scope, environment)` twice reuses one declaration; later calls only fill fields that were unset. See [Secrets](/cikick/docs/concepts/secrets/).

## 5. Export migrations and checks

```ts title="src/cikick.ts"
import { GENERATED_HEADER, type Check, type CikickPackageExports, type Migration } from '@cikick/core';

export const migrations: Migration[] = [ /* section 6 */ ];
export const checks: Check[] = [ /* section 7 */ ];

const exported: CikickPackageExports = { migrations, checks };
export default exported;
```

The CLI accepts either named exports or a default export with `migrations` (required, may be empty) and `checks` (optional). Checks from every discovered package are registered on the app *before* the consumer's config runs, so they apply to every `synth` and `check`.

## 6. Write a migration, end to end

Scenario: version 1 of `NodeCi` took `node: 20`. Version 2.0.0 renames the prop to `nodeVersion` and changes the workflow file name, so version 1 repositories have a stale generated `.github/workflows/node.yml`. The migration must:

1. rename the prop in every consumer's `cikick.config.ts`;
2. delete the legacy generated workflow, but only if cikick generated it.

### The migration API

```ts
interface Migration {
  /** semver of the package that introduced this migration */
  version: string;
  description: string;
  run(ctx: MigrationContext): Promise<void>;
}

interface MigrationContext {
  repoDir: string;
  readFile(path: string): string | undefined;   // repo-relative; undefined if absent
  writeFile(path: string, content: string): void;
  deleteFile(path: string): void;               // no-op if absent
  project: Project;                             // ts-morph project containing the config file
  log(msg: string): void;
}
```

`ctx.project` contains only the consumer's config file (`cikick.config.ts` and friends), not the rest of the repository or files it imports. Use `ctx.readFile`/`writeFile`/`deleteFile` for everything else.

### Step 1: the ts-morph transform

Keep the transform as an exported pure function of a `Project` so it can be unit-tested without touching disk. This is the real implementation:

```ts title="src/cikick.ts"
import { Node, Project, SyntaxKind } from 'ts-morph';

/** Rename prop `node` to `nodeVersion` in every `new NodeCi(scope, id, { node: ... })`. Returns number of renames. */
export function renameNodeProp(project: Project): number {
  let n = 0;
  for (const sf of project.getSourceFiles()) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      if (call.getExpression().getText() !== 'NodeCi') continue;
      for (const arg of call.getArguments()) {
        if (!Node.isObjectLiteralExpression(arg)) continue;
        const prop = arg.getProperty('node');
        if (!prop) continue;
        if (Node.isPropertyAssignment(prop)) prop.rename('nodeVersion');
        else if (Node.isShorthandPropertyAssignment(prop)) prop.replaceWithText(`nodeVersion: ${prop.getName()}`);
        else continue;
        n++;
      }
    }
  }
  return n;
}
```

Its limits are worth knowing, and worth stating in your CHANGELOG: it only matches `new NodeCi(...)` with that exact identifier and an inline object literal. An aliased import, `new ns.NodeCi(...)`, or props passed as a variable are not rewritten.

### Step 2: the migration

```ts
export const migrations: Migration[] = [
  {
    version: '2.0.0',
    description: 'Rename NodeCi prop `node` to `nodeVersion`; remove legacy cikick-generated .github/workflows/node.yml',
    async run(ctx) {
      const n = renameNodeProp(ctx.project);
      if (n) {
        await ctx.project.save();
        ctx.log(`renamed ${n} \`node\` prop(s) to \`nodeVersion\``);
      }
      const legacy = '.github/workflows/node.yml';
      const content = ctx.readFile(legacy);
      if (content !== undefined && content.startsWith(GENERATED_HEADER)) {
        ctx.deleteFile(legacy);
        ctx.log(`deleted legacy ${legacy}`);
      } else if (content !== undefined) {
        ctx.log(`kept ${legacy} (not generated by cikick)`);
      }
    },
  },
];
```

Design rules visible here:

- **Never delete a file you cannot prove cikick generated.** `GENERATED_HEADER` (exported from `@cikick/core`) is the first line of every generated YAML file. A hand-written `node.yml` is kept and logged.
- **Be idempotent.** Re-running finds no `node` prop and no generated legacy file, and does nothing.
- **Log what you did.** `ctx.log` lines appear in `cikick update` output.

### What the consumer sees

```bash
npx cikick update
```

```text
@acme/wf-node-ci: 1.4.0 -> 2.0.0
migrate @acme/wf-node-ci@2.0.0: Rename NodeCi prop `node` to `nodeVersion`; remove legacy cikick-generated .github/workflows/node.yml
renamed 1 `node` prop(s) to `nodeVersion`
deleted legacy .github/workflows/node.yml
wrote .github/workflows/ci.yml
...
wrote cikick.lock.json
```

Preview without changing anything with `npx cikick update --dry-run` (prints `would run <pkg>@<version>: <description>` per migration, or `no migrations to run`). To rerun a package's migrations by hand: `npx cikick migrate @acme/wf-node-ci --from 1.4.0 [--to 2.0.0]`.

## 7. Ship a check with `enforceAfter`

When a change cannot be migrated automatically, nudge consumers with a check that warns now and fails after a date:

```ts
import type { Check } from '@cikick/core';

/** Deprecation nudge: Node < 20 in .nvmrc warns now, errors after the date. */
export const nvmrcCheck: Check = {
  id: '@acme/wf-node-ci:nvmrc-min-node',
  severity: 'warn',
  enforceAfter: '2027-03-01',
  run(ctx) {
    const c = ctx.readFile('.nvmrc');
    if (c === undefined) return [];
    const major = parseInt(c.trim().replace(/^v/, ''), 10);
    if (Number.isNaN(major) || major >= 20) return [];
    return [{ checkId: '@acme/wf-node-ci:nvmrc-min-node', severity: 'warn', path: '.nvmrc', message: `Node ${major} is end-of-life; set nodeVersion >= 20 in NodeCi` }];
  },
};

export const checks: Check[] = [nvmrcCheck];
```

- `run(ctx)` receives `{ app, repoDir, readFile, settings?, files? }` and returns findings (sync or async). `ctx.app` lets you inspect the construct tree.
- A `warn` finding from a check with `enforceAfter` becomes `error` when the current time is later than that ISO date. `error` findings fail `cikick check` and mark `synth` as failed (exit 1); warnings print but do not.
- Prefix check ids with your package name so findings are attributable.

Consumers see `WARN  [@acme/wf-node-ci:nvmrc-min-node] .nvmrc: Node 18 is end-of-life; ...` until the date, then `ERROR ...`. See [Checks](/cikick/docs/concepts/checks/).

## 8. Test the package

The example's `test/node-ci.test.ts` uses vitest and exercises the public API directly. The patterns:

**Synth your construct with a pre-filled lockfile**, so no network is needed:

```ts
import { App, emptyLockfile, secretsManifest, synth } from '@cikick/core';
import { NodeCi } from '../src/index.js';

const lock = () => {
  const l = emptyLockfile();
  for (const k of ['actions/checkout@v4', 'actions/setup-node@v4', 'pnpm/action-setup@v4'])
    l.actions[k] = { sha: 'c'.repeat(40), resolvedAt: '2026-01-01T00:00:00Z' };
  return l;
};

it('synths ci workflow, nvmrc, renovate', async () => {
  const app = new App();
  new NodeCi(app, 'node', { nodeVersion: 24, packageManager: 'pnpm', release: {} });
  const r = await synth(app, { repoDir: mkdtempSync(join(tmpdir(), 'nci-')), lock: lock(), frozen: true });
  expect(r.files.map((f) => f.path)).toEqual(['.github/workflows/ci.yml', '.nvmrc', 'renovate.json']);
  expect(r.files[0]!.content).toContain(`pnpm/action-setup@${'c'.repeat(40)} # v4`);
  expect(secretsManifest(app)).toEqual([{ name: 'NPM_TOKEN', scope: 'repo', maxAgeDays: 90, provider: 'npm' }]);
});
```

**Test escape hatches and merged files** the same way (`ci.testJob.addOverride(...)`, then assert on `r.files[0].content`; write a `renovate.patch.json` into the temp `repoDir` to test merging).

**Test the migration** on an in-memory ts-morph project plus a temp directory for file operations:

```ts
const project = new Project({ useInMemoryFileSystem: true });
const sf = project.createSourceFile('cikick.config.ts', `
  import { NodeCi } from '@acme/wf-node-ci';
  const node = 20;
  export default (app) => {
    new NodeCi(app, 'ci', { node: 18, test: 'x' });
    new NodeCi(app, 'ci2', { node });
    new Other(app, 'o', { node: 1 });
  };`);
await mig.run({ repoDir: d, project, log: (m) => logs.push(m), writeFile() {}, deleteFile: (p) => rmSync(join(d, p), { force: true }), readFile: (p) => existsSync(join(d, p)) ? readFileSync(join(d, p), 'utf8') : undefined });
expect(sf.getFullText()).toContain('{ nodeVersion: node }');           // shorthand handled
expect(sf.getFullText()).toContain("new Other(app, 'o', { node: 1 })"); // other constructs untouched
```

Write one test with a `node.yml` starting with `GENERATED_HEADER` (expect it deleted) and one with a hand-written `node.yml` (expect it kept).

**Test the check**: call `check.run({ app: new App(), repoDir: '.', readFile })` with a stub `readFile`, and assert on `check.enforceAfter`. To test escalation use `effectiveSeverity('warn', '2027-03-01', new Date('2027-03-02'))` from `@cikick/core`, which returns `'error'`.

## 9. Versioning rules

`cikick update` decides what to run from the version recorded in the consumer's `cikick.lock.json` (`packages`) and the installed version:

- A migration runs when `from < migration.version <= to`, where `from` is the locked version and `to` the installed one. Migrations run in ascending version order (stable for equal versions). An invalid semver in `from`, `to` or a migration `version` throws.
- A migration's `version` is **the version of the package that introduces it**. Set it to the version you are about to release (`2.0.0` above) and publish that version. A migration tagged `2.1.0` inside a `2.0.5` release will not run until the consumer installs `2.1.0` or later.
- If the lock has no entry for the package (first adoption), cikick records the installed version and runs no migrations.
- If the installed version is older than the locked one, migrations are skipped.
- Use semver honestly: renamed or removed props, changed construct ids or output file names are major bumps and need a migration (or a check with `enforceAfter` when automation is not possible).

## 10. CHANGELOG convention

Keep a `CHANGELOG.md` in the package (and in `files`). The example uses one section per version with these headings, as needed:

```markdown
## 2.0.0

### Breaking
- `NodeCi` prop `node` was renamed to `nodeVersion` (default `22`).

### Migration
`npx cikick update` runs the `2.0.0` migration automatically. It:
1. Finds every `new NodeCi(scope, id, { node: ... })` in `cikick.config.ts` and renames the property ...
2. Deletes the legacy `.github/workflows/node.yml` **only** if it starts with the cikick generated-file header ...

### Checks
- `.nvmrc` below Node 20 warns; it becomes an error after 2027-03-01. Bump `nodeVersion` to fix.

### Other
- New `release` option ...
```

Renovate puts the changelog in front of the reviewer of the update PR, so say exactly what the migration changes and what it deliberately leaves alone.

## Troubleshooting

**Package not picked up by consumers.** The consumer must list it in `dependencies`/`devDependencies`, and the installed `package.json` needs a string `cikick` field pointing at a built file. `npm run build` before publishing.

**Migration did not run.** Check the consumer's `cikick.lock.json` `packages` entry for your package. If someone ran `cikick synth` after upgrading without `cikick update`, synth overwrote the recorded version with the installed one and the migration range is now empty. Fix with `npx cikick migrate <pkg> --from <old-version>`.

**`Migration has invalid semver`.** `version` must be a valid semver string such as `2.0.0`.

**`Duplicate output path`.** Two constructs produced the same file (two workflows with the same id, or a `ManagedFile` colliding with a workflow). Output paths are `.github/workflows/<workflow id>.yml` and each `ManagedFile.path`.

**Merged file ignores the consumer's patch.** The patch file is read from the repository root (`patchFile` is repo-relative) and must parse as the file's format; a parse error aborts synth with `cannot parse patchFile`.
