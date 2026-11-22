#!/usr/bin/env bash
# Publish a minimal placeholder version of each @cikick package that doesn't exist on npm yet,
# so a trusted publisher (OIDC) can be configured for it on npmjs.com.
#
# Usage:  npm login && ./scripts/npm-placeholders.sh [--dry-run]
# Needs:  npm >= 9, an npm account with publish rights on the @cikick scope (you'll be prompted for 2FA).
set -euo pipefail

PACKAGES=(@cikick/policies @cikick/fleet @cikick/workflows)
VERSION="0.0.0-placeholder.0" # prerelease, sorts below every real release
REPO="git+https://github.com/cikick/cikick.git"
DRY_RUN=""
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN="--dry-run"

npm whoami >/dev/null 2>&1 || { echo "Not logged in: run 'npm login' first." >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for name in "${PACKAGES[@]}"; do
  if npm view "$name" name >/dev/null 2>&1; then
    echo "skip  $name (already on npm)"
    continue
  fi
  dir="$work/${name#@cikick/}"
  mkdir -p "$dir"
  cat >"$dir/package.json" <<EOF
{
  "name": "$name",
  "version": "$VERSION",
  "description": "Placeholder to enable npm trusted publishing. Real releases are published from GitHub Actions.",
  "repository": { "type": "git", "url": "$REPO", "directory": "packages/${name#@cikick/}" }
}
EOF
  printf '# %s\n\nPlaceholder. Real releases: https://github.com/cikick/cikick\n' "$name" >"$dir/README.md"
  echo "publish $name@$VERSION"
  # --tag placeholder keeps it off `latest` where npm allows it (npm may still point latest at a package's first version).
  (cd "$dir" && npm publish --access public --tag placeholder $DRY_RUN)
  [[ -z "$DRY_RUN" ]] && npm deprecate "$name@$VERSION" "Placeholder, not a real release" || true
done

cat <<'EOF'

Next, for EACH of @cikick/core, cli, policies, fleet, workflows on npmjs.com:
  Package -> Settings -> Trusted Publisher -> GitHub Actions
    Organization or user: cikick
    Repository:           cikick
    Workflow filename:    release-please.yml
    Environment:          (leave empty)
Optionally then: Settings -> Publishing access -> "Require two-factor authentication and disallow tokens".
EOF
