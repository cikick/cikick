---
title: Customisation
description: The three ways to change a shared workflow without forking it - typed props, escape hatches, and aspects - and how to choose between them.
---

A shared workflow package cannot anticipate every repo. If the only way to change it is to fork it, every repo drifts. cikick gives consumers three levels of control, ordered from safest to most powerful. Use the lowest level that does the job; each step up couples you more tightly to the package's internals.

## Level 1: typed props

The construct's props are its public API. A breaking rename is a compile error, and package authors can ship a [migration](/cikick/docs/concepts/migrations/) that rewrites your config.

```ts title="cikick.config.ts"
import { NodeCi } from '@acme/wf-node-ci';

const ci = new NodeCi(app, 'node', {
  nodeVersion: 22,
  packageManager: 'pnpm',
  test: 'pnpm test -- --coverage',
  release: {},
  extraSteps: [{ name: 'Upload coverage', uses: 'actions/upload-artifact@v4', with: { name: 'coverage', path: 'coverage' } }],
});
```

Everything you can express through props is covered by the package's tests and upgrade path. Prefer it.

## Level 2: escape hatches

When the package does not expose what you need, reach into the construct tree. There are three mechanisms.

### Exposed members

Package authors can expose the pieces they build. `NodeCi` exposes `workflow`, `buildJob`, `testJob` and `releaseJob`, so you can add to them with the normal API:

```ts
ci.testJob.addStep({ name: 'E2E', run: 'pnpm e2e' });
```

### Direct props mutation

`Workflow.props`, `Job.props` and `Step.props` are plain mutable objects, and they are what rendering reads. Aspects are applied before rendering, so a change made here is visible to them, and checks see it too.

```ts
ci.buildJob.props.runsOn = ['self-hosted', 'linux'];
```

`Job` also has `permissions` and `needs` accessors that read and write the same props.

### Overrides on the rendered document

`addOverride(path, value)` and `addDeletionOverride(path)` exist on both `Workflow` and `Job` (not `Step`). They are applied to the rendered YAML object after rendering, in the order you called them. A workflow's overrides run after its jobs have rendered, so they can reach into any job.

```ts
ci.testJob.addOverride('runs-on', 'ubuntu-24.04');
ci.testJob.addOverride('env.CI', 'true');
ci.workflow.addOverride('concurrency.cancel-in-progress', false);
ci.workflow.addDeletionOverride('jobs.release.permissions.id-token');
```

Path rules (from `overrides.ts`):

- Segments are separated by `.`. Write `\.` for a literal dot inside a key (in a JS string, `'a\\.b'`).
- Paths address the **rendered** document, so use GitHub's names: `runs-on`, `timeout-minutes`, `cancel-in-progress`, not the camelCase prop names.
- A numeric segment indexes into an array: `jobs.test.steps.2.name`. Setting a path creates missing intermediate objects, or arrays when the next segment is numeric.
- Deleting an array index removes that element (the later ones shift down). Deleting a path whose parent does not exist does nothing.
- Setting replaces the whole value at the path; it does not merge.

```ts
ci.workflow.addOverride('jobs.build.steps.3.name', 'Compile');
```

:::caution
Overrides are applied to rendered output, so aspects and checks, which inspect construct props, do not see them. Setting `permissions` with `addOverride` will not satisfy `require-explicit-permissions`; set `props.permissions` instead. Numeric step indexes also break silently if the package reorders its steps in a new version.
:::

## Level 3: aspects

An aspect is a visitor registered on a scope. It runs once for every node at or below that scope, so one registration changes every workflow, job or step in the tree, including ones created inside packages you do not control.

```ts
interface IAspect {
  visit(node: IConstruct): void;
}

Aspects.of(app).add(aspect);
```

How they run (from `aspects.ts`):

- **Top-down inheritance.** A node is visited by the aspects of its ancestors first, then its own. An aspect added to `app` sees everything; one added to a single `NodeCi` sees only that subtree.
- **Registration order** is preserved within a scope.
- **Each aspect visits each node once** per synth.
- **Aspects may add nodes.** Children are re-read after a node is visited, so a step added to a job during `visit(job)` is itself visited.
- They run at the start of synth, before action refs are resolved, so an aspect can change `uses` and the new ref gets pinned.

A custom aspect that gives every workflow a concurrency group unless it already has one:

```ts
import { Aspects, Workflow, type IAspect, type IConstruct } from '@cikick/core';

class DefaultConcurrency implements IAspect {
  visit(node: IConstruct) {
    if (Workflow.isWorkflow(node) && node.props.concurrency === undefined) {
      node.props.concurrency = { group: '${{ github.workflow }}-${{ github.ref }}', cancelInProgress: true };
    }
  }
}
Aspects.of(app).add(new DefaultConcurrency());
```

Use the `Workflow.isWorkflow`, `Job.isJob` and `Step.isStep` guards rather than `instanceof`, so it works when several copies of `@cikick/core` are installed.

### Stock aspects in `@cikick/policies`

| Aspect | What it does |
|---|---|
| `new ExplicitPermissions({ default?, level? })` | Sets permissions where none are declared. Default `{ contents: 'read' }`; `level: 'workflow'` (default) sets them on workflows, `'job'` on every job lacking them. Never overwrites existing permissions. |
| `new DefaultTimeout(minutes)` | Sets `timeoutMinutes` on every job that has none, except reusable-workflow calls (`uses`). |
| `new HardenRunner({ egressPolicy?, action?, with? })` | Prepends a `step-security/harden-runner@v2` step (egress policy `audit` by default) to every job that has steps. Skips jobs that already start with it, and reusable-workflow calls. |
| `new ReplaceAction({ from, to })` | Replaces one exact `owner/repo[/path]@ref` with another on steps and jobs. Useful to move a whole repo off a deprecated action version. |

`applyBaseline(app)` registers `ExplicitPermissions` and `DefaultTimeout(30)` plus the stock checks in one call; that is where `timeout-minutes: 30` and `permissions: contents: read` in the example `ci.yml` come from.

```ts
import { Aspects } from '@cikick/core';
import { HardenRunner, ReplaceAction } from '@cikick/policies';

Aspects.of(app).add(new HardenRunner({ egressPolicy: 'block', with: { 'allowed-endpoints': 'github.com:443' } }));
Aspects.of(app).add(new ReplaceAction({ from: 'actions/upload-artifact@v3', to: 'actions/upload-artifact@v4' }));
```

## Choosing a level

| Situation | Use |
|---|---|
| The package has a prop for it | Props. |
| One repo needs a one-off tweak to a package's job | Exposed members or `props` mutation; use `addOverride` only for fields props cannot reach. |
| You need to set a raw YAML key the model does not have | `addOverride`. Keep a comment saying why; it is the most fragile option. |
| A rule must hold for every workflow in the repo (or in every repo via a shared package) | An aspect. |
| You want to be told when a rule is violated, not silently fix it | A [check](/cikick/docs/concepts/checks/), not an aspect. |

A useful pattern is an aspect to fix what is safe to fix automatically (permissions, timeouts) paired with a check for what needs a human decision.
