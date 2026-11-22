---
title: '@cikick/core'
description: API reference for @cikick/core - constructs, ActionRef, aspects, checks, lockfile, managed files, migrations, secrets, resolvers, synth and overrides.
---

`@cikick/core` is the construct library and synthesis engine behind the [`cikick` CLI](/cikick/docs/reference/cikick-cli/). Constructs come from the `constructs` package. See [Constructs and synth](/cikick/docs/concepts/constructs-and-synth/) for the model.

```ts title="cikick.config.ts"
import { App, Workflow } from '@cikick/core';

export default (app: App) => {
  const wf = new Workflow(app, 'ci', { on: { push: { branches: ['main'] } } });
  wf.addJob('test', { runsOn: 'ubuntu-latest' }).addStep({ run: 'npm test' });
};
```

## Rendering rules

Props are camelCase TypeScript; output is GitHub's YAML schema.

| Where                                                                   | Rule                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Step and job props                                                      | Explicit mapping: `runName` -> `run-name`, `runsOn` -> `runs-on`, `timeoutMinutes` -> `timeout-minutes`, `continueOnError` -> `continue-on-error`, `workingDirectory` -> `working-directory`, `strategy.failFast` -> `fail-fast`, `strategy.maxParallel` -> `max-parallel`.                                                                                                                      |
| `permissions` object keys                                               | `kebab-case`: `idToken` -> `id-token`, `pullRequests` -> `pull-requests`. Already-kebab keys pass through. `'read-all'` / `'write-all'` strings pass through.                                                                                                                                                                                                                                    |
| `on` event names                                                        | `snake_case`: `pullRequest` -> `pull_request`, `workflowDispatch` -> `workflow_dispatch`. Keys of each event's config object (one level) become `kebab-case`: `branchesIgnore` -> `branches-ignore`, `pathsIgnore` -> `paths-ignore`. A `null` event renders as `{}`. `on` given as a string or string array is emitted unchanged. Values nested deeper (for example input names) are untouched. |
| `concurrency`                                                           | A string is emitted as-is; an object renders `{ group, 'cancel-in-progress' }`.                                                                                                                                                                                                                                                                                                                  |
| `needs`                                                                 | `Job` instances become their node ids; a single entry renders as a scalar.                                                                                                                                                                                                                                                                                                                       |
| `env`, `with`, `defaults`, `services`, `container`, `outputs`, `matrix` | Emitted verbatim; keys are not transformed.                                                                                                                                                                                                                                                                                                                                                      |
| `undefined` values                                                      | Removed.                                                                                                                                                                                                                                                                                                                                                                                         |
| Pinned refs                                                             | `uses` renders as `owner/repo[/path]@<sha>` with a trailing `# <original ref>` comment when the ref was resolved from a non-SHA.                                                                                                                                                                                                                                                                 |

Job key order in output: `name, if, needs, runs-on, permissions, environment, concurrency, outputs, env, defaults, timeout-minutes, continue-on-error, strategy, services, container, uses, with, secrets, steps`. A job with `uses` (reusable workflow call) emits `with`/`secrets` and no `steps`; a job without `uses` emits `steps` only.

## Constructs

### App

`class App extends Construct`. Root of the tree.

| Member                                | Type                    | Description                                                                        |
| ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `new App(props?: AppProps)`           |                         |                                                                                    |
| `AppProps.outdir`                     | `string`                | Output directory; default for `synth`'s `repoDir`.                                 |
| `AppProps.lock`                       | `Lockfile`              | Starting lockfile.                                                                 |
| `outdir`                              | `string \| undefined`   |                                                                                    |
| `lock`                                | `Lockfile \| undefined` |                                                                                    |
| `synth(opts?: Partial<SynthOptions>)` | `Promise<SynthResult>`  | `synth(this, { ...opts, repoDir: opts.repoDir ?? this.outdir ?? process.cwd() })`. |

### Workflow

`class Workflow extends Construct`. `new Workflow(scope, id, props: WorkflowProps)`. The id is the file name: output path is `.github/workflows/<id>.yml`.

| `WorkflowProps` field | Type                                     | Description                       |
| --------------------- | ---------------------------------------- | --------------------------------- |
| `name`                | `string`                                 | Display name.                     |
| `runName`             | `string`                                 | `run-name`.                       |
| `on`                  | `WorkflowTriggers \| string \| string[]` | Required. Triggers.               |
| `permissions`         | `Permissions`                            | Workflow-level token permissions. |
| `concurrency`         | `string \| Concurrency`                  |                                   |
| `env`                 | `Record<string, string>`                 |                                   |
| `defaults`            | `Record<string, unknown>`                |                                   |

| Member                                                   | Description                              |
| -------------------------------------------------------- | ---------------------------------------- |
| `props: WorkflowProps`                                   | Mutable (aspects modify it).             |
| `filePath: string`                                       | `.github/workflows/<id>.yml`.            |
| `jobs: Job[]`                                            | Child jobs.                              |
| `addJob(id: string, props?: JobProps): Job`              |                                          |
| `actionRefs(): ActionRef[]`                              | All remote refs from jobs and steps.     |
| `addOverride(path, value)` / `addDeletionOverride(path)` | See [Overrides](#overrides).             |
| `toObject(): Record<string, unknown>`                    | Rendered object without pin comments.    |
| `static isWorkflow(x): x is Workflow`                    | Brand check, safe across package copies. |

### WorkflowTriggers

| Field               | Type                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `push`              | `PushTrigger \| null`                                            |
| `pullRequest`       | `PullRequestTrigger \| null`                                     |
| `pullRequestTarget` | `PullRequestTrigger \| null`                                     |
| `workflowDispatch`  | `{ inputs?: Record<string, WorkflowInput> } \| null`             |
| `schedule`          | `{ cron: string }[]`                                             |
| `workflowCall`      | `WorkflowCallTrigger \| null`                                    |
| `workflowRun`       | `{ workflows: string[]; types?: string[]; branches?: string[] }` |
| `[event: string]`   | `unknown`. Any other event, camelCase or snake_case.             |

| Interface             | Fields                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PushTrigger`         | `branches?`, `branchesIgnore?`, `tags?`, `tagsIgnore?`, `paths?`, `pathsIgnore?` (all `string[]`)                                                                                    |
| `PullRequestTrigger`  | `branches?`, `branchesIgnore?`, `paths?`, `pathsIgnore?`, `types?` (all `string[]`)                                                                                                  |
| `WorkflowInput`       | `description?: string`, `required?: boolean`, `default?: string \| number \| boolean`, `type?: 'string' \| 'number' \| 'boolean' \| 'choice' \| 'environment'`, `options?: string[]` |
| `WorkflowCallTrigger` | `inputs?: Record<string, WorkflowInput>`, `secrets?: Record<string, { description?; required? }>`, `outputs?: Record<string, { description?; value: string }>`                       |
| `Concurrency`         | `group: string`, `cancelInProgress?: boolean \| string`                                                                                                                              |

### Permissions

```ts
type PermissionLevel = 'read' | 'write' | 'none';
type Permissions = 'read-all' | 'write-all' | Record<string, PermissionLevel>;
```

### Job

`class Job extends Construct`. Created with `workflow.addJob(id, props)`; the id becomes the job key.

| `JobProps` field  | Type                                            | Description                                                                                 |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `name`            | `string`                                        |                                                                                             |
| `runsOn`          | `string \| string[] \| Record<string, unknown>` | `runs-on`.                                                                                  |
| `permissions`     | `Permissions`                                   |                                                                                             |
| `needs`           | `string \| Job \| (string \| Job)[]`            |                                                                                             |
| `if`              | `string`                                        |                                                                                             |
| `env`             | `Record<string, string>`                        |                                                                                             |
| `timeoutMinutes`  | `number`                                        |                                                                                             |
| `continueOnError` | `boolean`                                       |                                                                                             |
| `strategy`        | `Strategy`                                      | `{ matrix?: Record<string, unknown> \| string; failFast?: boolean; maxParallel?: number }`  |
| `environment`     | `string \| { name: string; url?: string }`      |                                                                                             |
| `outputs`         | `Record<string, string>`                        |                                                                                             |
| `concurrency`     | `string \| Concurrency`                         |                                                                                             |
| `defaults`        | `Record<string, unknown>`                       |                                                                                             |
| `services`        | `Record<string, unknown>`                       |                                                                                             |
| `container`       | `string \| Record<string, unknown>`             |                                                                                             |
| `uses`            | `ActionRef \| string`                           | Reusable workflow: `owner/repo/.github/workflows/x.yml@ref` or `./.github/workflows/x.yml`. |
| `with`            | `Record<string, unknown>`                       | Inputs for a reusable workflow; only rendered with `uses`.                                  |
| `secrets`         | `Record<string, string> \| 'inherit'`           | Only rendered with `uses`.                                                                  |

| Member                                                   | Description                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `props: JobProps`                                        | Mutable. `uses` strings are parsed to `ActionRef` (local `./` and `docker://` stay strings; other invalid specs throw). |
| `permissions`, `needs`                                   | Getter/setter shortcuts to `props`.                                                                                     |
| `steps: Step[]`                                          | Child steps in order.                                                                                                   |
| `addStep(step: StepProps): Step`                         | Appends a step (node id `step-<n>`).                                                                                    |
| `actionRefs(): ActionRef[]`                              | Refs from `uses` and steps.                                                                                             |
| `addOverride(path, value)` / `addDeletionOverride(path)` | Path relative to the job object.                                                                                        |
| `toObject()`                                             | Rendered object.                                                                                                        |
| `static isJob(x)`                                        | Brand check.                                                                                                            |

### Step

`class Step extends Construct`. Created through `job.addStep(props)`.

| `StepProps` field  | Type                      | Description                                   |
| ------------------ | ------------------------- | --------------------------------------------- |
| `id`               | `string`                  |                                               |
| `name`             | `string`                  |                                               |
| `uses`             | `ActionRef \| string`     | Strings are parsed with `ActionRef.tryParse`. |
| `run`              | `string`                  |                                               |
| `with`             | `Record<string, unknown>` |                                               |
| `env`              | `Record<string, string>`  |                                               |
| `if`               | `string`                  |                                               |
| `workingDirectory` | `string`                  |                                               |
| `shell`            | `string`                  |                                               |
| `timeoutMinutes`   | `number`                  |                                               |
| `continueOnError`  | `boolean`                 |                                               |

Members: `props: StepProps` (mutable), `actionRef: ActionRef | undefined`, `render(annotate?)`, `static isStep(x)`. Output key order: `name, id, if, uses, with, env, run, working-directory, shell, timeout-minutes, continue-on-error`.

Also exported: `REF_COMMENT_MARK`, and the `IConstruct` type.

## ActionRef

```ts
class ActionRef {
  static of(spec: string): ActionRef; // throws on invalid input
  static tryParse(spec: string): ActionRef | undefined;
  constructor(props: ActionRefProps);
}
interface ActionRefProps {
  owner: string;
  repo: string;
  path?: string;
  ref: string;
  sha?: string;
}
function isSha(ref: string): boolean; // /^[0-9a-f]{40}$/i
```

| Member                          | Description                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `of(spec)`                      | Parse `owner/repo[/path]@ref`. Splits at the last `@`. Throws `Invalid action ref "<spec>" (expected owner/repo[/path]@ref)`. |
| `tryParse(spec)`                | Like `of`, but returns `undefined` for specs starting with `./` or `docker://`.                                               |
| `owner`, `repo`, `path?`, `ref` | Parsed parts (readonly).                                                                                                      |
| `sha?`                          | Mutable. Initialized to `ref` when `ref` is a full SHA; set by `synth` after resolution.                                      |
| `key`                           | Lock key `owner/repo@ref`.                                                                                                    |
| `target`                        | `owner/repo[/path]`.                                                                                                          |
| `toSpec()`                      | Original `owner/repo[/path]@ref`.                                                                                             |
| `toString()`                    | `owner/repo[/path]@<sha ?? ref>`: the rendered form.                                                                          |

## Aspects

```ts
interface IAspect {
  visit(node: IConstruct): void;
}
class Aspects {
  static of(scope: IConstruct): Aspects;
  add(aspect: IAspect): void;
  readonly all: readonly IAspect[];
}
function applyAspects(root: IConstruct): void;
```

`applyAspects` walks the tree top-down; each node is visited by the aspects registered on itself and all its ancestors, each aspect at most once per node. Children are re-read after visiting, so aspects may add nodes. `synth` calls it before resolving refs. See [Customisation](/cikick/docs/concepts/customisation/) and [@cikick/policies](/cikick/docs/reference/policies/) for ready-made aspects.

## Checks

```ts
type Severity = 'info' | 'warn' | 'error';

interface Finding {
  checkId: string;
  severity: Severity;
  message: string;
  path?: string;
  fix?: () => void;
}

interface Check {
  id: string;
  severity: Severity;
  enforceAfter?: string; // ISO date; after it, warn findings are upgraded to error
  run(ctx: CheckContext): Finding[] | Promise<Finding[]>;
}

interface CheckContext {
  app: App;
  repoDir: string;
  readFile(path: string): string | undefined; // relative to repoDir
  settings?: RepoSettings;
  files?: SynthFile[]; // files produced by this synth
}

interface RepoSettings {
  defaultWorkflowPermissions?: 'read' | 'write';
  allowedActions?: 'all' | 'local_only' | 'selected';
  actionsEnabled?: boolean;
  [key: string]: unknown;
}

class Checks {
  static of(scope: IConstruct): Checks;
  add(check: Check): void;
  readonly all: readonly Check[];
}

interface RunChecksOptions {
  repoDir: string;
  settings?: RepoSettings;
  files?: SynthFile[];
  now?: Date;
}
function runChecks(app: App, opts: RunChecksOptions): Promise<Finding[]>;
function effectiveSeverity(severity: Severity, enforceAfter: string | undefined, now: Date): Severity;
```

`runChecks` runs the checks registered on every node of the tree (not just the root). For each finding, `checkId` defaults to the check's id, and severity is `effectiveSeverity(finding.severity ?? check.severity, check.enforceAfter, now)`: a `warn` becomes `error` once `now` is past `enforceAfter`; `info` and `error` are never changed. `fix` is part of the type but nothing in core or the CLI invokes it. The CLI does not populate `settings`. See [Checks](/cikick/docs/concepts/checks/).

## Lockfile

```ts
const LOCKFILE_NAME = 'cikick.lock.json';
interface LockedAction {
  sha: string;
  resolvedAt: string;
}
interface Lockfile {
  version: 1;
  actions: Record<string, LockedAction>; // key: owner/repo@ref
  packages: Record<string, string>; // cikick package versions at last synth
}
function emptyLockfile(): Lockfile;
function readLockfile(repoDir: string): Lockfile | undefined; // undefined if absent; fills missing actions/packages with {}
function writeLockfile(repoDir: string, lock: Lockfile): void;
function serializeLockfile(lock: Lockfile): string; // recursively sorted keys, 2-space indent, trailing newline
```

```json title="cikick.lock.json"
{
  "actions": {
    "actions/checkout@v4": { "resolvedAt": "2026-11-22T09:00:00.000Z", "sha": "<40-hex sha>" }
  },
  "packages": { "@your-org/wf-node": "1.3.0" },
  "version": 1
}
```

See [Lockfile and pinning](/cikick/docs/concepts/lockfile-and-pinning/).

## Managed files

```ts
type ManagedFileMode = 'managed' | 'seeded' | 'merged';
type ManagedFileFormat = 'yaml' | 'json' | 'text';
const GENERATED_HEADER: string;  // '# Generated by cikick — do not edit. Run `npx cikick synth`.'
function deepMerge(base: unknown, patch: unknown): unknown;
class ManagedFile extends Construct { constructor(scope, id, props: ManagedFileProps); render(repoDir: string): string; static isManagedFile(x) }
```

| `ManagedFileProps` field | Type                                | Description                                                                                                                                       |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`                   | `string`                            | Path relative to the repo root (backslashes normalized, leading `./` stripped).                                                                   |
| `mode`                   | `'managed' \| 'seeded' \| 'merged'` | `managed`: always overwritten. `seeded`: written only if absent. `merged`: overwritten, with `patchFile` merged over `content`.                   |
| `content`                | `object \| string`                  | Data, or a string (parsed for yaml/json formats).                                                                                                 |
| `format`                 | `'yaml' \| 'json' \| 'text'`        | Inferred: `.json` -> json, `.yml`/`.yaml` -> yaml, else `text` for string content or `json` for objects.                                          |
| `patchFile`              | `string`                            | Repo-owned file deep-merged over `content` in `merged` mode, parsed in the same format. Ignored if it does not exist; unparsable raises an error. |

Rendering: `text` returns the string as-is (error if `merged`, or if content is not a string). `json` is `JSON.stringify(data, null, 2)` plus newline, no header. `yaml` is stringified with `lineWidth: 0` and prefixed with `GENERATED_HEADER`, except `seeded` files, which get no header. `deepMerge`: objects merge recursively; arrays and scalars are replaced; a `null` in the patch deletes the key. See [Managed files](/cikick/docs/concepts/managed-files/).

## Migrations

```ts
interface Migration {
  version: string;
  description: string;
  run(ctx: MigrationContext): Promise<void>;
}
interface MigrationContext {
  repoDir: string;
  readFile(path: string): string | undefined;
  writeFile(path: string, content: string): void; // creates parent directories
  deleteFile(path: string): void; // no-op if absent
  project: Project; // ts-morph project containing the cikick config file
  log(msg: string): void;
}
interface CikickPackageExports {
  migrations: Migration[];
  checks?: Check[];
}
function selectMigrations<M extends Pick<Migration, 'version'>>(
  migrations: readonly M[],
  from: string,
  to: string,
): M[];
```

`selectMigrations` returns migrations with `from < version <= to` in ascending semver order, stable for equal versions. It throws `Invalid semver "<v>"` for an invalid `from`/`to`, and `Migration has invalid semver "<v>"` for a bad migration version. `CikickPackageExports` is the shape of the module referenced by a package's `package.json` `cikick` field. See [Migrations](/cikick/docs/concepts/migrations/) and [Authoring a package](/cikick/docs/guides/authoring-a-package/).

## Secrets

```ts
type SecretScope = 'repo' | 'env' | 'org';
interface SecretDeclProps {
  name: string;
  scope: SecretScope;
  environment?: string;
  maxAgeDays?: number;
  provider?: string;
  description?: string;
}
function secret(scope: IConstruct, name: string, opts?: Partial<Omit<SecretDeclProps, 'name'>>): string;
function secretsManifest(app: IConstruct): SecretManifestEntry[];
interface SecretManifestEntry {
  name;
  scope: SecretScope;
  environment?;
  maxAgeDays?;
  provider?;
  description?;
}
class SecretDecl extends Construct {
  /* SecretDeclProps as fields */ static isSecretDecl(x);
}
```

`secret(scope, name, opts)` registers a `SecretDecl` on the app root (scope defaults to `'repo'`) and returns the string `${{ secrets.NAME }}`. Repeated calls for the same name, scope and environment share one declaration; later calls fill in `maxAgeDays`, `provider` and `description` only where unset. `secretsManifest` returns all declarations sorted by name, scope, environment, with unset optional fields omitted. See [Secrets](/cikick/docs/concepts/secrets/).

```ts
job.addStep({
  run: 'npm publish',
  env: { NODE_AUTH_TOKEN: secret(app, 'NPM_TOKEN', { maxAgeDays: 90, provider: 'npm' }) },
});
```

## Resolvers

```ts
interface ActionResolver {
  resolve(owner: string, repo: string, ref: string): Promise<string>;
} // returns a commit sha
```

| Class                                                | Description                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHubResolver(opts?: { token?, fetch?, apiUrl? })` | `GET <apiUrl>/repos/<owner>/<repo>/commits/<ref>` (default `https://api.github.com`). Also accepts `(fetch, token)`. Sends `Authorization: Bearer <token>` if a token is set. Full SHAs are returned unchanged. Throws `Failed to resolve ...: HTTP <status>`. |
| `GitResolver(opts?: { host?, lsRemote? })`           | `git ls-remote https://<host>/<owner>/<repo>` (host default `github.com`, 30 s timeout). Peeled annotated tags (`^{}`) win, then tags, then branches. Throws `Failed to resolve ...: ref not found`.                                                           |
| `LockResolver(lock: Lockfile)`                       | Resolves from the lockfile only; throws `MissingLockEntryError` when absent. SHAs pass through.                                                                                                                                                                |
| `FallbackResolver(...resolvers)`                     | Tries each in order; if all fail, throws the last error.                                                                                                                                                                                                       |
| `MissingLockEntryError`                              | Has `key: string`. Message: `No lock entry for <key>. Run \`npx cikick lock\` (or synth without --frozen) to resolve it.`                                                                                                                                      |

Also exported types: `FetchLike`, `GitHubResolverOptions`, `LsRemote`.

## Synthesis

```ts
function synth(app: App, opts: SynthOptions): Promise<SynthResult>;

interface SynthOptions {
  repoDir: string;
  resolver?: ActionResolver; // default: LockResolver over the base lock
  frozen?: boolean; // throw FrozenLockError if any non-SHA ref is missing from the lock
  now?: Date;
  lock?: Lockfile; // default: app.lock, then <repoDir>/cikick.lock.json, then empty
  refresh?: boolean; // ignore existing lock entries
  packages?: Record<string, string>; // recorded in the lock; default: base lock's packages
  settings?: RepoSettings; // passed to checks
}
interface SynthResult {
  files: SynthFile[];
  lock: Lockfile;
  findings: Finding[];
}
interface SynthFile {
  path: string;
  content: string;
  mode: ManagedFileMode;
}

function writeSynthResult(
  result: SynthResult,
  repoDir: string,
  opts?: { writeLock?: boolean },
): { written: string[]; skipped: string[] };
function checkDrift(result: SynthResult, repoDir: string, opts?: { writeLock?: boolean }): string[];
function renderWorkflowYaml(wf: Workflow): string;
class FrozenLockError extends Error {
  missing: string[];
}
```

Pipeline: apply aspects; collect remote refs from all workflows; full-SHA refs are pinned as-is; other refs reuse lock entries (unless `refresh`), else are added to the missing list (frozen) or resolved concurrently and stamped with `resolvedAt`; each ref's `sha` is set; workflows and managed files render into `files` (sorted by path; duplicates throw `Duplicate output path: <path>`); checks run against the result. `FrozenLockError` message: `cikick.lock.json is missing entries (frozen mode): <keys>. Run \`npx cikick lock\` and commit the result.`

- `renderWorkflowYaml`: `GENERATED_HEADER`, newline, then YAML (`lineWidth: 0`, indent 2) with pin comments rendered as `uses: owner/repo@<sha> # <ref>`.
- `writeSynthResult`: writes files (creating directories), skipping `seeded` files that already exist (returned in `skipped`), then the lockfile unless `writeLock: false`.
- `checkDrift`: paths whose disk content differs from the result or is missing; `seeded` files only drift when missing; the lockfile drifts if its serialization differs, or if it is missing and `lock.actions` is non-empty.

## Overrides

Escape hatch for anything the props do not model. Exported: `addOverridePath(obj, path, value)` and `deleteOverridePath(obj, path)` for plain objects, plus `Workflow`/`Job` methods `addOverride(path, value)` and `addDeletionOverride(path)`. See [Customisation](/cikick/docs/concepts/customisation/).

Overrides apply to the rendered object (after the camelCase to kebab-case conversion), in the order they were added, so paths use output key names. A `Job` override path is relative to the job; a `Workflow` override path starts at the workflow root (for example `jobs.test.runs-on`).

| Rule          | Behaviour                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Separator     | `.`. `\.` escapes a literal dot in a key.                                                                        |
| Array indices | A purely numeric segment indexes into an array (for example `steps.0.with.cache`).                               |
| Set           | Intermediate missing or non-object values are created (an array if the next segment is numeric, else an object). |
| Delete        | Removes the key; for an array index it splices the element. A missing path is a no-op.                           |

```ts
job.addOverride('steps.0.with.fetch-depth', 0);
job.addDeletionOverride('timeout-minutes');
wf.addOverride('env.my\\.dotted\\.key', '1'); // writes key "my.dotted.key"
```
