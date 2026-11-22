# cikick docs site

Astro + Starlight. `npm ci && npm run dev` to work locally, `npm run build` to build into `dist/`.

## Deploying the docs

**GitHub Pages** (default, base `/cikick`): `.github/workflows/docs-pages.yml` (generated from the root `cikick.config.ts`).

**Cloudflare Workers** (static assets, base `/`): the base switches to `/` automatically when `WORKERS_CI` (Workers Builds) or `WRANGLER_COMMAND` (`wrangler deploy`) is set; override with `DOCS_BASE` / `DOCS_SITE`.

### Option A: repo-root config (default Git-connected build)

Root `wrangler.jsonc` serves `./docs-site/dist`. In the dashboard (Worker → Settings → Build):

- **Worker name** must equal `name` in `wrangler.jsonc` (`cikick`), or the build fails/deploys to a different Worker.
- **Root directory**: `/` (blank).
- **Build command**: `cd docs-site && npm ci && npm run build`. Required: Workers Builds ignores `build.command` in the Wrangler config. (`wrangler deploy` outside Workers Builds does run it.)
- **Deploy command**: `npx wrangler deploy` (default).

Locally, from the repo root: `docs-site/node_modules/.bin/wrangler deploy --dry-run` (after `cd docs-site && npm ci`).

### Option B: Root directory = `docs-site`

Set Build → **Root directory** = `docs-site`; `docs-site/wrangler.jsonc` (assets `./dist`) is used. Build command `npm ci && npm run build`, deploy command `npx wrangler deploy`. Same Worker-name rule.
