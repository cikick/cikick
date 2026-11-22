---
title: Lockfile and pinning
description: How cikick pins every action to a commit SHA in cikick.lock.json, how refs are resolved, what --frozen and --refresh do, and the limits of pinning.
---

A tag such as `actions/checkout@v4` is a pointer that its owner can move. If a workflow references the tag directly, what runs in your CI is whatever the tag points to at that moment, with your repo's token and secrets in reach. cikick resolves each tag once, records the commit SHA in `cikick.lock.json`, and renders the SHA into the workflow, so the code that runs only changes when the lockfile changes in a commit someone reviews.

## The lockfile

```json title="cikick.lock.json"
{
  "actions": {
    "actions/checkout@v4": {
      "resolvedAt": "2026-11-22T10:36:56.498Z",
      "sha": "11d5960a326750d5838078e36cf38b85af677262"
    },
    "actions/setup-node@v4": {
      "resolvedAt": "2026-11-22T10:36:56.498Z",
      "sha": "49933ea5288caeca8642d1e84afbd3f7d6820020"
    }
  },
  "packages": {
    "@acme/wf-node-ci": "2.0.0"
  },
  "version": 1
}
```

- `actions` is keyed by `owner/repo@ref` exactly as written in the config (`path` is not part of the key). Each entry has the resolved commit `sha` and an ISO `resolvedAt`.
- `packages` records the version of each cikick package (a dependency whose `package.json` has a `cikick` field) at the last synth. [`cikick update`](/cikick/docs/concepts/migrations/) compares it with what is installed.
- Keys are sorted and the file ends with a newline, so diffs are minimal and stable.
- Entries for refs no longer used by any workflow are dropped on the next synth.

Commit the lockfile. It is part of what `cikick check` verifies.

## Resolution

During synth, for each distinct non-SHA `owner/repo@ref`:

1. If the lock already has the key, the recorded SHA is used. A moved tag is **not** picked up automatically.
2. Otherwise the ref is resolved and a new entry is written with the current time.

A ref that is already a 40-character hex SHA bypasses the lock and renders as is (no `# ref` comment).

The CLI resolves with a `FallbackResolver` that tries two resolvers in order and throws the last error if both fail:

1. **`GitResolver`**: runs `git ls-remote https://github.com/<owner>/<repo>` (30 second timeout) for `refs/tags/<ref>`, its dereferenced form `refs/tags/<ref>^{}`, and `refs/heads/<ref>`. Annotated tags are dereferenced to the commit SHA. Preference order: dereferenced tag, then lightweight tag, then branch, so a tag wins over a branch with the same name. It needs `git` on the PATH but no token and no API rate limit.
2. **`GitHubResolver`**: calls `GET /repos/{owner}/{repo}/commits/{ref}` on the GitHub API, using `GITHUB_TOKEN` as a bearer token if set (anonymous otherwise, which is rate limited). This covers cases where `git ls-remote` fails, such as private action repos that git has no credentials for.

Only github.com is used by the CLI. `LockResolver` is the third resolver: it answers only from an existing lockfile and throws `MissingLockEntryError` for anything absent. Synth uses it when no resolver is supplied.

A short SHA (anything not 40 hex characters) is treated as a ref name and will not resolve through `git ls-remote`.

## Commands and flags

| Command                     | Resolution behaviour                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `cikick synth`              | Resolves only keys missing from the lock; writes workflows and lock.                                                                           |
| `cikick synth --frozen`     | Never resolves. If any non-SHA ref is missing from the lock, fails with `cikick.lock.json is missing entries (frozen mode): ...`.              |
| `cikick synth --refresh`    | Ignores existing entries and re-resolves every ref. This is how you deliberately move a pin forward.                                           |
| `cikick lock` (`--refresh`) | Same resolution as synth, but writes only `cikick.lock.json`, not the workflows.                                                               |
| `cikick check`              | Always frozen. Fails on missing lock entries, on drift (including a lockfile that differs from what synth would write), and on error findings. |

See the [CLI reference](/cikick/docs/reference/cikick-cli/) for the full option list, and [CI check guide](/cikick/docs/guides/ci-check/) for wiring `check` into a pipeline.

:::note
`--frozen` is for CI: it guarantees that nothing is resolved over the network at check time, so a pipeline cannot silently pin something new. Resolution belongs on a developer machine or in a dependency-update bot, where the resulting diff is reviewed.
:::

## What pinning protects against

- **A tag or branch being re-pointed after you adopted it.** Whoever controls the action repository (or compromises it) can move `v4` to different code. Your workflows keep running the commit that was resolved when the lock entry was created, until you refresh it.
- **Silent drift between repos.** All repos using the same shared package get SHAs from their own lockfile, and `cikick-fleet inventory` flags any `uses:` that is not a SHA.
- **Hand edits.** The generated YAML is compared byte for byte by `cikick check`, so swapping a SHA in the YAML without the lock changing shows up as drift.

## What it does not protect against

- **A bad commit that was pinned from the start.** If the code at the SHA was already malicious or vulnerable when you first resolved the tag, pinning preserves it faithfully. Pinning gives you stability, not trust.
- **Unreviewed upgrades.** `--refresh` (or a bot running it) replaces a SHA with whatever the tag points to now. Treat a lockfile diff like a dependency bump: look at what changed between the old and new commit before merging.
- **Things cikick does not render.** An action may itself call other actions or pull a container image internally; those references are inside the action's repository and are not controlled by your lockfile. Likewise hand-written workflows in the same repo are untouched.
- **Docker image references** are not resolved by cikick; `docker://` refs are passed through. The stock check `require-pinned-actions` flags `docker://` refs without an `@sha256:` digest. See [Checks](/cikick/docs/concepts/checks/).

## Edge cases

- The lock key is the ref string, so `actions/checkout@v4` and `actions/checkout@v4.2.0` are separate entries, and the same key used in ten workflows is one entry.
- Reusable-workflow calls (`uses: owner/repo/.github/workflows/x.yml@ref` on a job) are pinned the same way as step actions.
- If `git ls-remote` finds nothing and the API call fails, synth stops with the API error; no partial lockfile is written because files are written only after synth completes.
