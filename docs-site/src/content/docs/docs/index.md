---
title: Overview
description: What cikick is, what it replaces, and where to start.
---

cikick is a CDK-style manager for GitHub Actions. You describe workflows as TypeScript constructs; `cikick synth` renders plain `.github/workflows/*.yml`, resolves every action to a commit SHA, and records the result in `cikick.lock.json`. Shared workflows ship as npm packages that can carry migrations, so a breaking change reaches every repo as a pull request.

:::caution
cikick is pre-release (0.1.0). The packages in this repository are not yet published to a registry; see the [quickstart](/cikick/docs/guides/quickstart/) for how to run it today.
:::

## Packages

| Package | What it does |
|---|---|
| `@cikick/core` | Constructs, synth, lockfile, aspects, checks, managed files, secret declarations, migrations API |
| `@cikick/cli` | The `cikick` binary: `synth`, `check`, `lock`, `update`, `migrate`, `secrets`, `init` |
| `@cikick/policies` | Stock aspects and checks, plus `applyBaseline(app)` |
| `@cikick/fleet` | The `cikick-fleet` binary: `select`, `inventory`, `settings`, `secrets`, `report` over repos you select |

## Where to go

- **Why and how it fits together:** [constructs and synth](/cikick/docs/concepts/constructs-and-synth/), [lockfile and pinning](/cikick/docs/concepts/lockfile-and-pinning/), [migrations](/cikick/docs/concepts/migrations/), [fleet](/cikick/docs/concepts/fleet/).
- **Do something:** [quickstart](/cikick/docs/guides/quickstart/), [author a shared package](/cikick/docs/guides/authoring-a-package/), [Renovate](/cikick/docs/guides/renovate/), [CI check](/cikick/docs/guides/ci-check/), [fleet setup](/cikick/docs/guides/fleet-setup/).
- **Look something up:** [`cikick` CLI](/cikick/docs/reference/cikick-cli/), [`cikick-fleet` CLI](/cikick/docs/reference/cikick-fleet-cli/), [core API](/cikick/docs/reference/core/), [policies](/cikick/docs/reference/policies/).
