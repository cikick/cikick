# cikick docs site

Astro + Starlight. docs-site is part of the pnpm workspace: `pnpm install` at the repo root, then `pnpm --filter cikick-docs-site dev` / `build` (output in `docs-site/dist`).

## Deploying the docs

Deployed to **Cloudflare Workers** (static assets, base `/`). Override with `DOCS_BASE` / `DOCS_SITE`.

### Option A: repo-root config (default Git-connected build)

Root `wrangler.jsonc` serves `./docs-site/dist`. In the dashboard (Worker → Settings → Build):

- **Worker name** must equal `name` in `wrangler.jsonc` (`cikick`), or the build fails/deploys to a different Worker.
- **Root directory**: `/` (blank).
- **Build command**: `pnpm --filter cikick-docs-site build`. Required: Workers Builds ignores `build.command` in the Wrangler config. Dependencies are installed automatically by Workers Builds with pnpm (detected from `pnpm-lock.yaml`, version from the root `packageManager` field). (`wrangler deploy` outside Workers Builds does run it.)
- **Deploy command**: `npx wrangler deploy` (default).

Dry run, from the repo root: `docs-site/node_modules/.bin/wrangler deploy --dry-run` (Option A) or `pnpm exec wrangler deploy --dry-run` inside `docs-site` (Option B).

### Option B: Root directory = `docs-site`

Set Build → **Root directory** = `docs-site`; `docs-site/wrangler.jsonc` (assets `./dist`) is used. Build command `pnpm build`, deploy command `npx wrangler deploy`. Same Worker-name rule.
