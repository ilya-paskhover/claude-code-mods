---
name: check-mod
description: Check the mods a branch or PR changes in this repo, from a cloud session; a PR or branch other than the checked-out one is checked in a separate worktree. Runs a code review subagent in the background alongside `claude plugin validate`, `claude plugin test` and a type check on each changed plugin under plugins/, tells a failure the branch caused from one already on main, verifies each review finding, then writes a prompt the user pastes into Claude Code on their own computer for the live check there. Use when asked to check, test, review or verify a mod change, a branch or a PR here, or "test it locally".
argument-hint: "[PR number or branch, default the checked-out branch] [--base <ref>, default origin/main] [--second-review]"
---

# Check a mod change

A cloud session can run the automated checks and a code review, but it can't do the live check: mod panes don't show in live cloud sessions (issue #14), and the desktop app and the user's real sessions aren't in the container. So this skill:

1. Starts a code review in the background.
2. Runs the automated checks while the review runs.
3. Checks each review finding against the code.
4. Writes a prompt for the user's own computer, which does the live check there.

Never report a mod as working from the automated checks and review alone. Say that the live check is still to do.

## 1. Pick what to check

`$ARGUMENTS` can name what to check and what to compare it with:

- **Nothing**: the checked-out branch, uncommitted changes included. Check it where it is and skip the rest of this step.
- **A PR number** (`22` or `#22`): read the PR (GitHub MCP `pull_request_read`, method `get`) for its head branch and head commit. If the PR is merged or closed, say so and ask before going on. A PR from a fork can't be fetched from `origin`: say so and stop.
- **A branch name**: that branch on `origin`.
- **`--base <ref>`**, with or without the above: what to compare with. The default is `origin/main`.
- **`--second-review`**: also run the optional agent-skills reviewer (step 3).

For a PR or branch, never switch the current checkout, which may hold someone's work. Check it in a separate worktree instead:

```
git fetch origin main <branch>
git worktree add --detach <scratchpad>/check-<branch with / as -> origin/<branch>
```

Run every later git, review and check command from inside that worktree, and give `check.sh` by its path in the current checkout (the branch being checked may not have this skill yet). If the PR's head commit isn't the worktree's `HEAD`, the branch moved since the PR was read: say which commit you checked. When the report is done, remove the worktree with `git worktree remove --force <path>`.

## 2. Find what changed

- Run `git fetch origin main` first when the base is the default.
- Run `git diff --stat <base>...HEAD` and `git status --short`, and read the diff of each changed mod (`plugins/<mod>/`), so you can brief the reviewer and write live steps for what changed.
- If no mod under `plugins/` changed, say so and stop. Changes to README, `.github/` or this skill need no mod check.

## 3. Start the review, in the background

Start it before the checks, so it runs while they do. Launch a subagent with the Agent tool, `run_in_background: true`:

- **Reviewer**, in the order the README's "Reviewing a PR" section gives: `agent-skills:code-reviewer` if it's in the Agent tool's list, else `pr-review-toolkit:code-reviewer`, else `general-purpose`. `agent-skills` is optional and doesn't install itself in a cloud session; `pr-review-toolkit` does. Say in the report which one ran.
- **Second reviewer, only with `--second-review`**: also launch the other of those two, if it's in the list; if it isn't installed, say so and go on with one. Don't run both unasked: on a small diff two reviewers mostly add findings to check. Suggest `--second-review` in the report when the change is risky (state kept across sessions, error handling, a large diff).
- **Brief**, the same for each:
  - The worktree's path, and that the review is read-only: no branch switch, commit or edit.
  - The diff: `git diff <base>...HEAD -- <changed mod folders> README.md`, run in that worktree.
  - In two or three sentences, what the change does, from the diff and the PR's description.
  - The risky parts of this diff to focus on: state kept across sessions or reloads, shared files several sessions write, what the engine's own files might not contain, what each surface draws.
  - Limits the README or PR description already states: not findings, unless the code is worse than stated.
  - Report only merge-blocking problems, each with the file, the line at the branch's head, why it's wrong and a concrete input or sequence that shows it failing. Say plainly if nothing blocks.

Don't wait on the reviewer: go on to steps 4 and 5. Its result arrives as a notification.

## 4. Get the type file

The engine writes a mod's types to `plugins/<mod>/.claude-plugin/types/` only when it loads the mod, so a fresh checkout has none.

- If that folder exists for every changed mod, skip this step.
- Otherwise load the built-in `plugin-authoring` skill (Skill tool). Its text names this build's API type file, a path ending in `plugin-authoring/types/claude-code.d.ts`. Use that path as the types file.
- If that skill isn't available, run the checks without a types file. The type check then shows as skipped; report it as skipped, never as passed.

## 5. Run the checks

```
bash <this checkout>/.claude/skills/check-mod/check.sh <base> <types file>
```

For each changed mod it runs `validate`, `test` and `tsc`, and prints `<mod> <check> pass|fail|skipped (note)`. A failed check is run again on the base commit:

- `also fails on base: pre-existing`: the same problems are on main. Report it, but it doesn't block the change.
- `new on this branch` or `fails on base too, with different problems`: the branch caused it. Read the output printed under the summary, find the cause in the diff, and report it with the file and line.

The script exits 1 only for failures the branch caused. A `validate` warning about a missing icon is known and not a failure.

If a changed mod has a test file but the diff added no test for new behaviour, say so.

## 6. Check the review findings

When each reviewer reports, check every finding against the code yourself before it goes in the report:

- Read the lines it names, at the branch's head. Follow the failing sequence it gives through the code.
- Where a test could show it, write one in a scratch copy of the mod (never the worktree) and run `claude plugin test` on that copy.
- **Confirmed**: you traced it, or a test shows it. **Plausible**: the reasoning holds but you couldn't show it. **Dropped**: it doesn't hold; give the reason in one line.
- With two reviewers, merge findings that are the same problem, and note which reviewer found what.

## 7. Write the live-check prompt

Write a prompt the user pastes into Claude Code on their own computer. Save it in the scratchpad directory as `check-<branch>.md` (the branch name with `/` replaced by `-`), send it with SendUserFile, and also show it in the reply.

The prompt must stand alone: the session that reads it has none of this conversation. It contains:

1. **What to check out**: the repository (`ilya-paskhover/claude-code-mods`), the branch, the commit checked here, and the PR number if there is one. Fetch and switch to the branch. If there are uncommitted changes, stop and ask.
2. **The automated checks again on their machine**: `claude plugin test` and `claude plugin validate` for each changed mod, with the pass count you saw.
3. **The live check**: how to load the branch's copy without touching the installed one. Either `claude --plugin-dir <clone>/plugins/<mod>`, or the `CLAUDE_CODE_PLUGIN_DIRS` route in the README's development section; both need the marketplace copy of that mod disabled or uninstalled first so it doesn't load twice, and re-enabled at the end. Then numbered steps, one at a time, waiting for the user after each. Write the steps from the diff: what to do, and what they should see if it works. Include a restart, or a second session, where the change keeps state across sessions. Include the desktop app if the change touches what it draws or opens. Add a step that tries each confirmed or plausible review finding live, where one can be seen in the pane.
4. **The report**: one table, with every check and step as pass, fail or skipped.
5. **No commits, pushes or PR comments** unless the user asks.

The review already ran here, so the prompt starts none. If no reviewer could run here, add one to the prompt instead: a background subagent on the same brief, started before the checks, whose findings the local session checks against the code before reporting.

If the user would rather do the live check in a cloud session, mention the README's setup-script snippet (it installs a branch's copy of a mod into a new cloud session). Add that panes won't show there (#14), so only commands and the status line can be checked that way.

If the prompt is ready before the review is in, send it, and give the review findings when they arrive.

## 8. Report

- What was checked: the branch and commit (and PR number), or "the checked-out branch".
- One line per mod and check, as the script printed, with the cause of each failure the branch caused.
- What was skipped and why.
- The review: which reviewer(s) ran, then each confirmed or plausible finding with the file, line, why and how it fails, and the dropped ones in one line each. "Nothing blocks" when that's the result.
- The path of the live-check prompt.
- Last: whether the change is ready for its live check, or what has to be fixed first.
