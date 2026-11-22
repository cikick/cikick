# Landing page review (persona: platform lead, 30–300 repos)

Built with `npm run build`, served with `astro preview`, and screenshotted at 1280 and 390 px, light and dark, with reduced motion on and off. Every claim was checked against `packages/*/src`.

**30-second test:** I can say what it is ("CDK for GitHub Actions: TS → pinned YAML, shared as npm packages"). I **can't** say why I'd need it over Renovate plus reusable workflows, because the hero sells SHA pinning, which I already get from Renovate. I also can't say what my next step is: "Try it in 3 commands" clones *your* monorepo, so nothing happens in *my* repo. The real differentiator (one breaking change becomes N migration PRs) only appears in the 3rd section.

## Findings

### P0

1. **Hero: it leads with the commodity feature.**
   - **Problem:** the hero animation shows `@v3 → @sha # v4`. Renovate's `helpers:pinGitHubActionDigests` does exactly this, and the page admits it lower down.
   - **Fix:** make the hero visual a compressed update loop: one package release → N repo PRs, each with a config diff and `check ✓`. Suggested copy:
     > **Ship a CI change to 80 repos as one release.**
     > Write workflows as TypeScript, publish them as an npm package, and let Renovate deliver each change, breaking ones included, as a migrated, SHA-pinned PR in every repo.

2. **Hero/Quickstart: the CTA overpromises.**
   - **Problem:** "Try it in 3 commands" is really clone the cikick monorepo, `pnpm install && pnpm build && pnpm install`, then check an example. Packages are unpublished (0.1.0). The skeptic only finds that out in the last section and feels baited.
   - **Fix:**
     - Put a `v0.1 · pre-release · not yet on npm` pill in the hero eyebrow.
     - Rename the CTA to "Run the example (from source)".
     - Make the secondary CTA "Read how it works" (link to the concepts page).

3. **Problem card "keeping the pins current" + Pipeline: nothing shows how pins get refreshed.**
   - **Problem:** the lockfile maps `ref → sha`. Re-resolution only happens on `cikick lock --refresh` or `synth --refresh`. Nothing automatic is shown or implemented.
   - **Worse, an actual product conflict:** the `NodeCi` managed `renovate.json` extends `helpers:pinGitHubActionDigests`. Renovate will bump digests directly in *generated* `ci.yml`. Then `cikick check` fails on drift, or `postUpgradeTasks: cikick update` re-synths from the lock and reverts the bump.
   - **Fix:** either say plainly "refresh pins with `cikick lock --refresh` (e.g. a scheduled workflow)", or build a Renovate custom manager for `cikick.lock.json`. Until then, drop "keeping the pins current" as a claim. Also fix or explain the digest-helper conflict in `examples/wf-node-ci/src/index.ts`.

4. **Fleet + Problem card 2: "secret rotation" is overclaimed.**
   - **Problem:** `secrets rotate` *distributes* a value you already minted to N repos (sealed-box PUT). It doesn't mint the new token, revoke the old one, or talk to npm. `SecretDecl.provider` is metadata only. A security-minded reader will call this out.
   - **Fix:** retitle the card to "A new secret value reached 2 of 9 repos". In Fleet, add: *"cikick-fleet pushes a value you provide to every selected repo/env and reports age. Minting and revoking at the provider is still yours."*
   - **Also missing:** "why not org-level secrets scoped to selected repos?" That is the first question the persona will ask. Answer it: env-scoped secrets, per-repo values, and repos outside one org are the honest cases.

### P1

5. **Why not…: replace the six cards with the table below. Fix the overstated and missing comparisons.**
   - **Reusable workflows:** "The caller gets inputs and nothing else" is too strong. The calling job can also set `secrets` (incl. `inherit`), `permissions`, `strategy`/matrix, `concurrency`, `if` and `needs`. Suggested copy: *"Callers can pass inputs, secrets and job-level settings, but can't add or change a step inside the called jobs."*
   - **"Each caller still pins its own @ref and still needs a bump PR":** true, but many orgs use `@main` deliberately to avoid that. Say why that is worse (unreviewed changes go live in every repo at once, which is the tj-actions failure mode in-house).
   - **Missing alternatives the persona actually uses:**
     - Org **rulesets with required workflows**: central enforcement, no per-repo PR.
     - **Workflow templates** (`.github` repo starter workflows).
     - **File-sync / multi-repo PR tools** (repo-file-sync-action, multi-gitter, turbolift).
     - **Org-level secrets.**

     These are cikick's real competitors for this persona, more than github-workflows-kt.
   - **Keep the two "good fit / wrong call" cards.** They are the most credible thing on the page. Move them directly under the table.

6. **Update loop: the diff contradicts its caption.**
   - **Problem:** step 4 says "Config, generated YAML and lockfile change together", but the diff shows only the config plus a deleted file. Steps 1–5 also skip what the persona fears most:
     - What happens when the migration can't apply (a repo used `addOverride` on the renamed thing)?
     - Who merges 80 PRs?
   - **Fix:**
     - Add a `ci.yml` hunk to the diff.
     - Add one line under the step list: *"If a codemod can't apply, `cikick update` fails the PR with the reason. Renovate automerge works once `cikick check` is green."*
     - **Check the first sentence against `update.ts` before publishing it.** The code wasn't checked for this failure path.

7. **Pipeline lede: one sentence contradicts the page.** "Nothing cikick-specific executes in your CI" conflicts with the recommended `cikick check` CI step. Replace with *"The generated YAML runs without cikick. `cikick check` is an optional CI gate."*

8. **Problem: the section's visual weight goes to the wrong things.**
   - The tag-hijack card is the largest card, and it covers the problem Renovate and zizmor already solve.
   - The drift card's real point ("updating means 9 PRs by hand") is the one cikick uniquely solves.
   - **Fix:** make drift the wide card and shrink the tag card to a one-paragraph note. The tj-actions facts (Mar 2025, CVE-2025-30066, tags re-pointed, secrets dumped to logs) are accurate. Keep them.

9. **Fleet: required permissions are not stated.** It needs admin on each repo. `select` filters to `permissions.admin`, so presumably a PAT or app token. Add one line: which token, which scopes. Also state that rulesets are **report-only** (true in `settings.ts`). Right now "settings drift" reads as if it fixes everything.

### P2

10. **Animation:**
    - **Helps:** the drift grid and the tag re-point. They are comprehensible without reading.
    - **Decoration:**
      - The pipeline construct tree (middle column, lots of dead space at 1280).
      - The 9-tile fleet grid, which duplicates the terminal next to it.
      - Five separate "Replay" buttons add noise.
    - **Fix:** cut the tree to a one-line caption, drop all Replay buttons except the hero's, and let the update loop play once.
11. **Layout:**
    - Pipeline column 3 wraps YAML lines at 1280 (`- uses:` / `actions/checkout@…` split). Widen it or use `white-space:pre` with scroll.
    - The quickstart terminal clips "# 2nd install links th…" at 1280.
    - The update-loop step-dot digits render oddly small or misaligned in headless Chromium (`font:700 .9rem var(--ck-font)`). Check on a real device.
12. **Accessibility** (axe-core, WCAG 2 AA):
    - **Contrast:**
      - Light theme: `.v.ok` pill (`#0f7a3d` on `#deebe2`) is 4.41:1 (needs 4.5:1). Darken to about `#0b6b34`.
      - Dark theme: `.tile-off .dim` (`#7d7b8b` on `#15141d`) is 4.41:1. Lighten to about `#8a889a`.
    - **Scrollable `<pre>`:** `#qs-cmds` and the update-loop terminals are scrollable but not focusable. Add `tabindex="0"`.
    - **Heading order is fine:** h1 → h2 → h3.
    - **Reduced motion is good:** final states render immediately, with no transform or transition.
    - **No horizontal scroll** at 390.
    - **Mobile length:** the page is about 13,800 px tall at 390. Collapse the comparisons on mobile once they become a table (horizontal scroll inside the table only, first column sticky).

## Proposed comparison table

**Placement:** directly after the "Why not just…" lede, replacing the six cards. The cards' best sentences go into a short "Notes" list under the table (one line per tool: "use it when…"), followed by the existing two fit cards.

Legend: ✓ yes · ◐ partial · ✗ no · ? unverified.

| | Shared across repos | Per-repo customisation | Breaking-change migrations | SHA pinning | Lockfile | Secret distribution / fleet ops | Static analysis | No build step | Maturity |
|---|---|---|---|---|---|---|---|---|---|
| **cikick** | ✓ npm packages | ✓ props, `addOverride`, aspects | ✓ versioned codemods via `cikick update` | ✓ at synth (refresh is manual: `lock --refresh`) | ✓ `cikick.lock.json` | ◐ age report + push a value to selected repos; no mint/revoke | ◐ 5 stock checks + custom `Check`s | ✗ synth step | ✗ 0.1, unpublished |
| **Reusable workflows** | ✓ native | ◐ inputs, secrets, job-level settings; not steps | ✗ | ◐ caller pins `@sha` by hand | ✗ | ✗ | ✗ | ✓ | ✓ GA |
| **Composite actions** | ◐ steps only | ◐ inputs only | ✗ | ◐ by hand | ✗ | ✗ | ✗ | ✓ | ✓ GA |
| **Org rulesets / required workflows** | ✓ enforced centrally | ✗ same workflow everywhere | ✗ | ◐ by hand in the one file | ✗ | ✗ | ✗ | ✓ | ✓ (plan availability: unverified) |
| **Org-level secrets** | ✓ | ◐ select repos; one value | n/a | n/a | n/a | ◐ one value, many repos; no age policy | n/a | ✓ | ✓ |
| **Renovate / Dependabot** | ✗ per-repo copies | n/a | ✗ bumps strings | ✓ Renovate digest pinning; Dependabot bumps SHAs (pinning on its own: unverified) | ✗ | ✗ | ✗ | ✓ | ✓ |
| **File sync / multi-repo PR tools** | ◐ copy files out | ◐ via templating (unverified) | ◐ scripted, not versioned | ✗ | ✗ | ✗ | ✗ | ✓ | ◐ varies |
| **projen** | ✓ npm packages | ✓ escape hatches | ◐ re-synth; breaks surface as compile errors, no shipped codemods (unverified) | ? unverified | ? unverified | ✗ | ✗ | ✗ synth step | ✓ widely used |
| **github-workflows-kt** | ◐ Kotlin scripts/libs | ✓ code | ✗ (unverified) | ? unverified | ✗ (unverified) | ✗ | ✓ typed action inputs | ✗ script step | ◐ active, niche |
| **zizmor / actionlint** | n/a (analysis only) | n/a | ✗ | ◐ flags unpinned uses (zizmor) | ✗ | ✗ | ✓ deeper than cikick | ✓ | ✓ |

**Footnote under the table:** *"Third-party cells reflect our reading of their docs as of Nov 2026; cells marked ? or 'unverified' are ones we have not confirmed. Corrections welcome (link to an issue)."* This is what turns "Honest comparisons" from a claim into a demonstrated behaviour.

**Source checks for the cikick row:**
- **Lockfile:** `core/lockfile.ts`, `core/resolver.ts` (git ls-remote).
- **Migrations:** `cli/update.ts`.
- **Checks:** `policies/checks.ts` has 5 checks in the baseline, plus the deprecation check.
- **Fleet:** `fleet/secrets.ts` (sealed-box PUT, `stale`/`missing` statuses); `fleet/selection.ts` (`NotSelectedError`); `fleet/settings.ts` (rulesets report-only).
- **`SecretDecl.provider`:** metadata only.

## Missing user problems (the persona would list these and doesn't see them)

- **Enforcement vs. opt-in.** What stops a team from deleting cikick or hand-editing YAML? (`cikick check` is opt-in per repo, while org required workflows are enforced centrally.) Say how you'd make the check required.
- **PR volume.** "Renovate noise" is named in the brief but never addressed. A release fans out into N PRs. Talk about automerge, grouping, and Renovate's org-wide preset.
- **Rollout / canary.** Ship v2 to 5 repos first, then everyone. Is semver ranges per repo the answer? Say so.
- **Visibility across the fleet.** Which repos are on which version of the shared package? `cikick-fleet inventory`/`report --html` does this, but the page never shows it. It is a strong platform-lead feature, so surface it.
- **Self-hosted runners / runner labels, OIDC to cloud instead of long-lived secrets.** Name them as constructs, or admit they're plain props.
- **Multi-language repos.** cikick needs Node/npm in every repo, including Go, Python and Java repos. State the footprint (dev-dependency only? a `package.json` in a Go repo?). This is the #1 adoption objection and it's absent.
- **Exit cost.** "If you stop using cikick, the committed YAML keeps working." This is true and very persuasive. Say it in the hero or the fit cards.
- **GHES / Enterprise compatibility and auth model** (PAT vs. GitHub App) for fleet.

## Repo hygiene (spotted in passing)

- `docs-site/.astro/preview.json` and `preview.log` are committed, and `astro preview` rewrites them. Add `docs-site/.astro/` to `.gitignore` and `git rm --cached` them.
