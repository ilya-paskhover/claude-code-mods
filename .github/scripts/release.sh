#!/usr/bin/env bash
# Creates a GitHub release for every mod version on main's history that has no
# tag yet, tagged <mod>-v<version> since each mod has its own version. Safe to
# rerun: it backfills past versions and picks up each new bump.
# DRY_RUN=1 prints what it would create. Needs full history and tags.
set -euo pipefail

for dir in plugins/*/; do
  mod=$(basename "$dir")
  manifest="${dir}.claude-plugin/plugin.json"
  previous_sha=''
  previous_version=''
  # First-parent: a version counts from when it reached main, not from the
  # feature-branch commit that bumped it, so its release holds all of that PR.
  for sha in $(git log --first-parent --reverse --format=%H -- "$manifest"); do
    version=$(git show "$sha:$manifest" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')
    [ "$version" = "$previous_version" ] && continue

    tag="$mod-v$version"
    range=${previous_sha:+$previous_sha..}$sha
    notes=$(git log --no-merges --format='- %s' "$range" -- "$dir")
    previous_sha=$sha
    previous_version=$version

    git rev-parse -q --verify "refs/tags/$tag" >/dev/null && continue
    if [ "${DRY_RUN:-}" = 1 ]; then
      printf '%s at %s\n%s\n\n' "$tag" "${sha:0:7}" "$notes"
    else
      # Mods version separately, so no single release is the repo's latest.
      gh release create "$tag" --target "$sha" --title "$mod $version" --notes "$notes" --latest=false
    fi
  done
done
