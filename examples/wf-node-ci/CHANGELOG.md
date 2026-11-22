# Changelog

## 2.0.0

### Breaking

- `NodeCi` prop `node` was renamed to `nodeVersion` (default `22`).

### Migration

`npx cikick update` runs the `2.0.0` migration automatically. It:

1. Finds every `new NodeCi(scope, id, { node: ... })` in `cikick.config.ts` and renames the property to `nodeVersion` (using ts-morph, so formatting and comments are preserved).
2. Deletes the legacy `.github/workflows/node.yml` **only** if it starts with the cikick generated-file header (hand-written workflows are left alone).

### Checks

- `.nvmrc` below Node 20 warns; it becomes an error after 2027-03-01. Bump `nodeVersion` to fix.

### Other

- New `release` option (tag-triggered npm publish using a `NPM_TOKEN` secret declared with a 90-day max age).
- Ships `.nvmrc` (managed) and `renovate.json` (merged with your `renovate.patch.json`).
