#!/usr/bin/env bash
# Runs the automated checks on every mod a branch changes, and on the base
# commit for any check that fails, so a failure the branch did not cause is
# labelled as such.
#
# Usage: check.sh [base-ref] [types-file]
#   base-ref    what the branch is compared with (default origin/main)
#   types-file  claude-code.d.ts to type-check against when a mod has no
#               engine-written .claude-plugin/types/ (the plugin-authoring
#               skill names one when it loads); without it, tsc is skipped.
#
# Prints one line per check: <mod> <check> <pass|fail|skipped> [note], then
# the output of each failure. Exits 1 if a check fails on the branch but not
# on the base, else 0.
set -uo pipefail

base_ref=${1:-origin/main}
types_file=${2:-}
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
work=$(mktemp -d)
trap 'git worktree remove --force "$work/base" >/dev/null 2>&1; rm -rf "$work"' EXIT

base=$(git merge-base HEAD "$base_ref") || { echo "no merge base with $base_ref" >&2; exit 2; }

# Committed, staged, unstaged and untracked changes all count.
mods=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } |
  sed -n 's#^plugins/\([^/]*\)/.*#\1#p' | sort -u)
if [ -z "$mods" ]; then
  echo "No mod under plugins/ changed since $(git rev-parse --short "$base")."
  exit 0
fi

# tsc against the mod's own types when the engine wrote them, else the given
# types file. lib ES2022 keeps the DOM lib from clashing with the engine's globals.
typecheck() { # <mod dir> <out file>
  local dir=$1 out=$2 cfg
  if [ -f "$dir/.claude-plugin/types/tsconfig.json" ]; then
    npx -y -p typescript tsc -p "$dir" >"$out" 2>&1
    return
  fi
  [ -n "$types_file" ] || return 3
  cfg="$work/tsconfig-$(basename "$dir")-$RANDOM.json"
  cat >"$cfg" <<EOF
{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext",
    "moduleResolution": "Bundler", "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment",
    "lib": ["ES2022"], "types": [] },
  "include": ["$types_file", "$dir/hooks", "$dir/types"] }
EOF
  npx -y -p typescript tsc -p "$cfg" >"$out" 2>&1
}

run() { # <check> <mod dir> <out file>
  case $1 in
    validate) claude plugin validate "$2" >"$3" 2>&1 ;;
    test) claude plugin test "$2" >"$3" 2>&1 ;;
    tsc) typecheck "$2" "$3" ;;
  esac
}

# The tsc and test lines that name a problem, without what differs between the
# branch and the base checkout for the same problem: the path up to the mod's
# folder, line and column numbers (the branch may have moved the code), timings.
problems() { # <out file>
  grep -E 'error TS|^\(fail\)' "$1" | sed -E 's#^.*plugins/[^/]+/##; s#\([0-9]+,[0-9]+\)##; s# \[[0-9.]+ms\]##' | sort -u
}

new_failures=0
failed=()
for mod in $mods; do
  dir="$root/plugins/$mod"
  if [ ! -d "$dir" ]; then
    echo "$mod - removed (skipped)"
    continue
  fi
  for check in validate test tsc; do
    out="$work/$mod-$check.txt"
    run "$check" "$dir" "$out"
    status=$?
    if [ $status -eq 3 ]; then
      echo "$mod $check skipped (no types: pass a types-file)"
      continue
    fi
    if [ $status -eq 0 ]; then
      echo "$mod $check pass"
      continue
    fi
    # Failed: run the same check on the base, if the mod existed there.
    note='new on this branch'
    if git cat-file -e "$base:plugins/$mod/.claude-plugin/plugin.json" 2>/dev/null; then
      [ -d "$work/base" ] || git worktree add --detach -q "$work/base" "$base" >/dev/null 2>&1
      base_out="$work/$mod-$check-base.txt"
      if run "$check" "$work/base/plugins/$mod" "$base_out"; then
        :
      else
        # Same named problems on both sides: none of them is the branch's.
        extra=$(comm -23 <(problems "$out") <(problems "$base_out"))
        if [ -z "$extra" ] && [ -n "$(problems "$out")" ]; then
          note='also fails on base: pre-existing'
        else
          note='fails on base too, with different problems'
        fi
      fi
    fi
    echo "$mod $check fail ($note)"
    failed+=("$out")
    [ "$note" = 'also fails on base: pre-existing' ] || new_failures=$((new_failures + 1))
  done
done

for out in "${failed[@]}"; do
  printf '\n===== %s =====\n' "$(basename "$out" .txt)"
  tail -n 60 "$out"
done
[ $new_failures -eq 0 ]
