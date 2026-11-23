# claude-code-mods

Small mods for [Claude Code](https://claude.com/claude-code), built on its function-hooks plugin API.

| Mod | What it does |
| --- | --- |
| [turn-pulse](plugins/turn-pulse) | A status line summarizing the last turn, live while Claude works, with an optional band above the prompt. |
| [notes](plugins/notes) | `/note` saves chat text to a notes list shared across projects; `/notes` opens it in a side pane. |
| [sessions](plugins/sessions) | `/sessions` opens a side pane listing the sessions running on this machine and whether each is working or idle. |
| [config-map](plugins/config-map) | `/config-map` opens a side pane mapping your Claude Code config: every CLAUDE.md block by file, category and model, and every settings key per file, each unfolding to its content. |

> **Early access.** The mod API these use is marked EARLY ACCESS and may change between Claude Code releases. Built and tested on Claude Code 2.1.293, on Windows, in the desktop app's Code tab.

## Install

In a terminal, add the marketplace once:

```
claude plugin marketplace add ilya-paskhover/claude-code-mods
```

Then install one line per mod:

```
claude plugin install turn-pulse@claude-code-mods
```

```
claude plugin install notes@claude-code-mods
```

```
claude plugin install sessions@claude-code-mods
```

```
claude plugin install config-map@claude-code-mods
```

This installs in the user scope, so the mod loads in every new session, including sessions the desktop app starts. Inside an interactive `claude` session, `/plugin marketplace add` and `/plugin install` take the same arguments. `/plugin` is not available inside the desktop app's Code tab, so install from a terminal.

To update, refresh the marketplace, then update each mod you installed:

```
claude plugin marketplace update claude-code-mods
```

```
claude plugin update turn-pulse@claude-code-mods
```

```
claude plugin update notes@claude-code-mods
```

```
claude plugin update sessions@claude-code-mods
```

Restart running sessions to apply an update.

## turn-pulse

Between turns the status line shows the last turn and the session's spend:

```
last turn 35s · no edits · 3 ok · session: 5h +2% · week +0%
```

- **Duration** of the turn.
- **Files edited**: the first 3, then `+N`. An edit **outside the session's working folder** shows as `⚠ outside: name`, with a 15 second toast.
- **Tool results**: `N ok`, and `N failed (Tool ×n)` when something failed.
- **Usage-limit spend** of the session so far.

During a turn the status line shows `▶ Tool · N ok · ✗ N failed` live. A toast appears when a turn takes 60 seconds or more.

The band above the prompt is optional and off by default, so it leaves the slot to other mods:

![turn-pulse: the last-turn band above the prompt](docs/turn-pulse.png)

- `/pulse band on` or `/pulse band off` sets it, and `/pulse band` switches it. The band's **Hide** button also turns it off. The choice is kept across sessions and projects.
- The band labels the row **◆ last turn** and shows the same parts in color, with the **turn's** usage-limit cost rather than the session's. The duration turns yellow past 2 minutes.
- When on, it shares the slot: another mod's band draws below it.

`/pulse` says whether the band is on. In a cloud session `/pulse` prints the last turn and the session total as text instead, since the Claude app showing the session may not draw the band or the status line.

Limits:

- Usage numbers are account-wide, so other sessions running at the same time count toward them.
- Tracking starts when the mod loads, and the handling of a limit window resetting is heuristic.
- Paths are compared case-insensitively. That is right on Windows but could misjudge an "outside" edit on a case-sensitive Linux file system.

## notes

![notes: the Notes side pane with an open note](docs/notes.png)

- `/note <text>` saves the typed text. With text selected in the transcript, `/note <comment>` saves the selection with the typed text as its comment.
- Notes are kept in the mod's own store, shared across all sessions and projects.
- `/notes` opens a **Notes** side pane: notes render as Markdown, long ones fold behind More/Less, and each has a ☐/☑ done toggle, Delete, and Jump (scroll to the message it came from; same session only). Show/Hide done and Clear done act on the whole list.
- Text pasted into the prompt has its `<pasted_content>` wrapper stripped.

Limits:

- In the desktop app the selection is not passed to mods, so `/note` there needs pasted or typed text, and Jump never appears. Selection is documented to work in the fullscreen terminal; I have not verified that. Tracked in [#1](https://github.com/ilya-paskhover/claude-code-mods/issues/1).
- Jump only scrolls within the session the note was taken in; mods can't open another session. Tracked in [#4](https://github.com/ilya-paskhover/claude-code-mods/issues/4).
- When no surface draws the pane, as in a cloud session ([#14](https://github.com/ilya-paskhover/claude-code-mods/issues/14)), `/notes` and `/note` say why instead of claiming it opened.

## sessions

<table><tr>
<td valign="top"><img src="docs/sessions.png" width="400" alt="sessions: the Sessions side pane, its header counting 1 working, 2 idle and 6 ended sessions, with a Switch button and two ended sessions under their parent"></td>
<td valign="top"><img src="docs/sessions-nesting.png" width="347" alt="sessions: a session with two spawned children indented under it, each row naming its model"></td>
</tr></table>

`/sessions` opens a **Sessions** side pane listing every Claude Code session running on this machine, from any folder:

- A count per status, drawn with the same dot and color as its rows (● working, ○ idle, · ended), and a Refresh button.
- One row per session: ● **working** (yellow) or ○ **idle** (green), the session's name, how long since its last activity, and "this session" on your own row.
- A **Switch** button on each session the desktop app started opens that session in the app. Sessions started in a terminal have no button.
- Working sessions sort first, then the most recently active, ended ones last.
- **History**: a session that has exited stays listed, dimmed as · **ended**, for 3 days after it was last seen. The history is kept in the mod's own store, shared by every session on this machine, so it survives restarts. **Hide ended** / **Show ended** toggles those rows.
- **Folding**: a session with sessions under it has a **▾ N** button, N being how many sessions sit under it at any depth. Press it to fold them away (it then reads **▸ N**); press again to unfold. Folds last for the session.
- A session spawned by another one, such as a `claude -p` run started from a Bash call or a session started from another in the desktop app, shows indented under its parent (local sessions only), even after the parent has ended.
- Each local session's row names the model it runs on, once its desktop file or transcript says.
- The pane refreshes every 5 seconds while it is open and stops when you close it.
- The pane opens by itself once per local session: at start in a terminal, or when the desktop app connects. It opens unfocused, so the prompt keeps the keyboard. Close it and it stays closed for that session, through reloads and desktop reconnects.

In a cloud session, where the container holds only that one session, `/sessions` lists your cloud sessions active in the last 3 days (up to 50) instead, from the `claude-code-remote` MCP server every cloud session has:

- ● **working**, ◐ **needs input** with what the session is waiting on, ✗ **failed**, or ○ **idle** (finished or ready for review).
- An **Open** link on each other session goes to its page on claude.ai.
- The pane refreshes every 30 seconds, since each refresh is an API call.

Limits:

- Opened by itself, the pane shows only in a window at least 144 columns wide, or 110 once you have opened it with `/sessions`. In a narrower one it waits until you run `/sessions`. Cloud sessions don't open it by themselves, since each refresh there is an API call; `/sessions` opens it.
- The list comes from Claude Code's own files in `~/.claude/sessions/` (or `$CLAUDE_CONFIG_DIR/sessions/`), not from the mod API. That format is undocumented and could change in any release; if no file can be read, the pane says so instead of showing a wrong list.
- Locally, only sessions on this machine appear: those running now, and those ended in the last 3 days while some session here had the mod loaded (a session that started and ended with no other session watching is not in the history). Cloud sessions do not appear.
- Two sessions refreshing at the same moment can each overwrite the other's history write; a running session reappears on the next refresh, but an ended one caught that way is lost. In a cloud session, only cloud sessions appear, not the ones on your computer.
- The cloud list is the `claude-code-remote` server's `list_sessions` output, which is not a documented format either; if it can't be read, the pane says so. In a live cloud session the plugin loads and `/sessions` runs, but the pane does not appear; tracked in [#14](https://github.com/ilya-paskhover/claude-code-mods/issues/14). When no surface draws the pane, `/sessions` says why instead of claiming it opened.
- Nesting comes from the process table, since session files don't name a parent, and from the desktop app's own session files for sessions it started. Those files, like the transcripts the model name comes from for other sessions, are not mod API and could change in any release; the pane then shows no model or a flatter list. A model read from a transcript is kept for that session's life, so a later `/model` doesn't show. The pane opens before those are read, so a new session's parent and model can appear a moment later. A child whose parent has exited stays under it while the parent is in the history; a new session that reuses the parent's process id does not adopt it. If the process table can't be read, the list stays flat and the pane tries again after 5 seconds, then less often, down to once a minute.
- Switch works only for sessions the desktop app started, through an undocumented `claude://` link, not a mod API (tracked in [#4](https://github.com/ilya-paskhover/claude-code-mods/issues/4)).
- In the desktop app, a click on the pane first gives it focus, so a button may need two clicks: one to focus the pane, one to press. The pane opens focused, so the first click right after `/sessions` works; after you click elsewhere, click anywhere in the pane (or Refresh) first. Press Esc to give the keyboard back to the prompt.
- Sessions and Notes open as tabs in the same side pane; mod panes can't be shown side by side. Tracked in [#5](https://github.com/ilya-paskhover/claude-code-mods/issues/5).
- A session that crashed can leave its file behind. The session file only changes when the status changes, so a "working" row shows dimmed as "working?" once it has been busy for 30 minutes: either a long turn or a crash. The pane can't tell which.

## config-map

`/config-map` scans your configuration and opens a side pane with two tabs. Every row unfolds to its content; **Fold all** closes them.

- **Instructions**: every instruction file that loads (managed, user `CLAUDE.md`, `~/.claude/rules`, project and local `CLAUDE.md`, `.claude/rules`, and each `@import` they pull in), and whether it loads always or on demand (rules with `paths:` frontmatter). Below that, every block of those files, split at headings and grouped by file, with its category and the model it is for. Unfold a block to read its lines. Blocks tagged for a model other than the one the session runs are marked ⚠, and the **Blocks for** picker shows one model's blocks.
- **Settings**: user, project, local, `--settings` and managed settings, read through Claude Code itself, so each platform's paths are covered. Each top-level key shows a one-line summary (`3 allow, 1 deny`, env variable names, hook event names, a short value) and unfolds to its value as JSON. Every `env` value, and any value under a key that reads like a secret (token, secret, password, credential, auth, API key, helper), shows as `•••`.

Tagging blocks. A heading that names a model (`# Opus 5.5 tuning`, `## Sonnet 5.5 additions`) tags its block and the headings nested under it. To tag any block, put a marker under its heading:

```markdown
## Subagents
<!-- model: opus-5.5 -->
<!-- category: Agents -->
```

Several models go comma-separated (`<!-- model: opus-5.5, sonnet-5.5 -->`). Without a category marker, the category is guessed from keywords (Git, Secrets, Email, Safety, Testing, Agents, Reporting, Style, General).

To drop a model's blocks in one step when you switch models, move them to their own file, say `~/.claude/models/opus-5.5.md`, and add `@models/opus-5.5.md` to `~/.claude/CLAUDE.md`. Removing that one line drops them all, and the pane shows the imported file as its own row.

Limits:

- Your claude.ai profile preferences and the system prompt are not files on disk, so the pane does not list them.
- Masking goes by key name: a secret written inside an ordinary value (a token in a hook's command line, say) shows when that key is unfolded.
- The scan runs when you type `/config-map` or press Refresh, not on every change.

## Developing

Each mod is a plugin folder under `plugins/`. To run a working copy instead of the installed one, name the folders in the `env` block of `~/.claude/settings.json` (separated by `;` on Windows, `:` elsewhere) and uninstall the marketplace copy so the mod does not load twice:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-mods/plugins/turn-pulse;/path/to/claude-code-mods/plugins/notes"
  }
}
```

Interactive sessions watch those folders and reload a mod when its files are saved. Checks, per mod folder:

```
claude plugin validate plugins/notes
```

```
claude plugin test plugins/notes
```

To try a branch's copy of a mod in a cloud session, add these lines to the cloud environment's setup script, set `BRANCH` and `MOD`, then start a new session. They copy the mod into a one-mod marketplace and install it from there:

```sh
BRANCH=claude/my-branch
MOD=sessions
git clone --depth 1 -b "$BRANCH" https://github.com/ilya-paskhover/claude-code-mods /tmp/mod-branch
M=/tmp/mod-branch-mkt
mkdir -p $M/.claude-plugin $M/plugins
cp -r /tmp/mod-branch/plugins/$MOD $M/plugins/
cat > $M/.claude-plugin/marketplace.json <<EOF
{"name":"mod-branch","owner":{"name":"Ilya Paskhover"},"plugins":[{"name":"$MOD","source":"./plugins/$MOD"}]}
EOF
claude plugin marketplace add $M && claude plugin install $MOD@mod-branch
```

In the session, `claude plugin list` should then show `<mod>@mod-branch` enabled.

From a Claude Code session in this repo, `/check-mod` checks every mod a branch changes: `claude plugin validate`, `claude plugin test` and a type check, with failures already on `main` marked as such, plus a code review by a background subagent (the reviewers below) whose findings are checked against the code; `--second-review` runs both reviewers. Then the live check. Mod panes don't show in a cloud session, so there it runs what shows in data with real Claude Code sessions in the container (a mod's command, its store, the session files; with a control run on the base commit), then writes a prompt to paste into Claude Code on your own computer for the drawing; run on your computer, it does the live check itself, starting sessions and reading state for each step and asking you what the pane shows. `/check-mod 22` checks a PR, `/check-mod <branch>` a branch, each in a separate worktree; `--live-only` skips straight to the live check when a cloud run already did the rest on the same commit. There is nothing to install: the skill lives in the repo (`.claude/skills/check-mod/`), so any session with a checkout that includes it has it, including every new cloud session once it is on `main`.

Each mod's `tsconfig.json` extends the type declarations the engine writes into `.claude-plugin/types/` when it loads the mod (gitignored), so `tsc -p plugins/notes` works once the mod has loaded once.

### Releases

Bump `version` in a mod's `.claude-plugin/plugin.json` and merge to `main`: a workflow creates the release, tagged `<mod>-v<version>`, with the commits that touched that mod as its notes. See [`release.sh`](.github/scripts/release.sh). Run it with `DRY_RUN=1` to see what it would create. Installs don't depend on releases: the marketplace reads `plugin.json` from the repository.

### Reviewing a PR

`.claude/settings.json` enables two review plugins for every session in this repo, so Claude Code asks once to trust their marketplaces: Addy Osmani's [`agent-skills`](https://github.com/addyosmani/agent-skills) and Anthropic's [`pr-review-toolkit`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit).

In a cloud session only `pr-review-toolkit` loads by itself; `agent-skills` is not installed there. Optionally, install it with:

```
claude plugin marketplace add addyosmani/agent-skills
claude plugin install agent-skills@addy-agent-skills
```

It loads from the next session on. A cloud container starts fresh each session, so to have it in every cloud session, put those two lines in the environment's setup script. It adds about 4,000 tokens to every session for its 34 skills, used or not.

1. Run `/agent-skills:code-review-and-quality` first: one agent, one report, few false alarms.
2. For a risky PR, add `/pr-review-toolkit:review-pr errors tests`, which finds what the first one misses about error handling and tests. Add `comments` or `types` when those changed; `all` runs every agent.

On [#16](https://github.com/ilya-paskhover/claude-code-mods/pull/16) the two together found every issue, and neither did alone (see the comparison comments there and on [#12](https://github.com/ilya-paskhover/claude-code-mods/pull/12)).

## License

[MIT](LICENSE)
