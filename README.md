# cikick

CDK-style workflow manager for GitHub Actions, distributed as npm packages.

- **Author** workflows as TypeScript constructs → `npx cikick synth` → `.github/workflows/*.yml`
- **Share** workflows/jobs/config as npm packages; override anything per repo (props, `addOverride`, aspects)
- **Pin** every action to a commit SHA in `cikick.lock.json` (`git ls-remote`, no token needed)
- **Guard** with checks/aspects (`@cikick/policies`): pinned actions, explicit permissions, script injection, deprecations with `enforceAfter`
- **Migrate**: packages ship versioned codemods; `npx cikick update` runs them when Renovate bumps a version
- **Fleet**: `cikick-fleet` over repos _you select_ — inventory, settings drift, secret age policy, multi-repo secret rotation

| Package                                      |                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`@cikick/core`](packages/core)              | constructs, synth, lockfile, aspects, checks, managed files, secrets, migrations API |
| [`@cikick/cli`](packages/cli)                | `cikick synth \| check \| lock \| update \| migrate \| secrets \| init`              |
| [`@cikick/policies`](packages/policies)      | stock aspects/checks, `applyBaseline(app)`                                           |
| [`@cikick/fleet`](packages/fleet)            | `cikick-fleet select \| inventory \| settings \| secrets \| report`                  |
| [`examples/wf-node-ci`](examples/wf-node-ci) | example shared workflow package with a migration                                     |
| [`examples/consumer`](examples/consumer)     | example repo consuming it, with generated output committed                           |

```ts
// cikick.config.ts
import { NodeCi } from '@acme/wf-node-ci';
import { applyBaseline } from '@cikick/policies';

export default (app) => {
  const ci = new NodeCi(app, 'ci', { nodeVersion: 22, packageManager: 'pnpm' });
  ci.testJob.addStep({ name: 'E2E', run: 'pnpm e2e' });
  ci.workflow.addOverride('jobs.build.runs-on', ['self-hosted', 'linux']);
  applyBaseline(app);
};
```

In CI: `npx cikick check` fails on drift or policy errors. In Renovate: `postUpgradeTasks: ["npx cikick update"]`.

Design: [docs/PLAN.md](docs/PLAN.md).

## Develop

```bash
pnpm install && pnpm build && pnpm test
pnpm typecheck && pnpm lint && pnpm format:check
pnpm lint && pnpm format:check
```
