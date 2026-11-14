# Helpers for a data-level live check: real Claude Code sessions run against a
# copy of a mod, and the state its pane would draw from is read back. Source
# it, then write the scenario for the change at hand:
#
#   source .claude/skills/check-mod/live.sh
#   live_begin <mod folder>          # the copy to check; installed copy off
#   trap live_end EXIT               # always undo what live_begin did
#   live_bg "Use the Bash tool to run exactly: sleep 20. Then reply done."
#   live_wait_status "$LIVE_PID" busy
#   live_command sessions >/dev/null # one run of /sessions: its hooks fire
#   live_store history               # the mod's store, the "history" key, as JSON
#
# Notes from getting this to work:
# - A cloud session sets CLAUDE_CODE_REMOTE=true; a mod that branches on it
#   takes its cloud path. Every session here runs with it unset, as on a
#   person's computer.
# - `claude -p "/<command>"` runs a mod's slash command with no model call
#   (about 2 seconds). Panes don't draw (#14), but the command's hooks, its
#   reads and its $.store writes all run.
# - A `claude -p` session writes ~/.claude/sessions/<pid>.json like any other,
#   with status busy while its turn runs. Asking it to run `sleep N` through
#   the Bash tool keeps it busy for N seconds at the cost of one short turn.
# - $! is the claude process only when claude is started directly: a shell
#   function or `timeout` in front makes $! another process's pid.
# - `setsid -f` starts a session outside this one's process tree (parent pid
#   1), as from another terminal.
# - A mod loaded with --plugin-dir keeps its store in
#   ~/.claude/plugins/store/<mod>_inline-<hash>.json.

LIVE_SESSIONS=~/.claude/sessions
LIVE_STORE=~/.claude/plugins/store
LIVE_MOD=''
LIVE_PID=''
LIVE_PIDS=()
LIVE_FILES=()
LIVE_REENABLE=''
LIVE_BACKUP=''

# The copy of the mod to load, with an empty store. Every existing
# <mod>_inline-*.json store (a person's own --plugin-dir or
# CLAUDE_CODE_PLUGIN_DIRS copy keeps its data there too) is moved aside and
# put back by live_end. The installed copy of the same mod is turned off so it
# doesn't load twice; live_end turns it back on.
# shortcut: a session of the person's that has the mod loaded inline can still
# write its store during the run, and live_end puts the saved copy back over it.
live_begin() {
  LIVE_MOD=$1
  local name f; name=$(basename "$1")
  LIVE_BACKUP=$(mktemp -d) || return 1
  for f in "$LIVE_STORE/$name"_inline-*.json; do
    [ -e "$f" ] && { mv "$f" "$LIVE_BACKUP/" || return 1; }
  done
  [ -n "$(ls -A "$LIVE_BACKUP")" ] && echo "stores of $name saved in $LIVE_BACKUP until live_end"
  # One entry is "❯ <mod>@<marketplace>" (">" on some terminals; an
  # alternation, not [>❯], since ❯ is three bytes outside a UTF-8 locale), then
  # Version, Scope and "Status: ✔ enabled" or "Status: ✘ disabled".
  if claude plugin list 2>/dev/null | grep -A3 -E "^ *(>|❯) $name@claude-code-mods\$" | grep -qE '^ *Status:.* enabled$'; then
    claude plugin disable "$name@claude-code-mods" >/dev/null && LIVE_REENABLE="$name@claude-code-mods"
  fi
}

# A file the scenario creates, deleted by live_end. Refuses a path that
# already exists, so live_end never deletes a file it didn't make.
live_file() { # <path> <content>
  [ -e "$1" ] && { echo "live_file: $1 exists, not touched" >&2; return 1; }
  printf '%s' "$2" >"$1" && LIVE_FILES+=("$1")
}

# Undoes live_begin: stops every session started here, deletes the files
# made with live_file and the test store, puts the saved stores back, turns
# the installed copy back on.
live_end() {
  local pid="" f _
  # Ctrl+C twice, as a person quits a session; whatever is left after 10 s
  # is killed.
  for pid in "${LIVE_PIDS[@]}"; do kill -INT "$pid" 2>/dev/null; done
  sleep 1
  for pid in "${LIVE_PIDS[@]}"; do kill -INT "$pid" 2>/dev/null; done
  for _ in $(seq 10); do
    for pid in "${LIVE_PIDS[@]}"; do kill -0 "$pid" 2>/dev/null && break; pid=''; done
    [ -z "$pid" ] && break
    sleep 1
  done
  for pid in "${LIVE_PIDS[@]}"; do kill -KILL "$pid" 2>/dev/null && echo "killed $pid"; done
  for f in "${LIVE_FILES[@]}"; do rm -f "$f"; done
  rm -f "$LIVE_STORE/$(basename "$LIVE_MOD")"_inline-*.json
  if [ -n "$LIVE_BACKUP" ]; then
    # Keep the folder if a move fails, so the saved stores aren't lost.
    mv "$LIVE_BACKUP"/* "$LIVE_STORE/" 2>/dev/null
    rmdir "$LIVE_BACKUP" 2>/dev/null || echo "saved stores left in $LIVE_BACKUP" >&2
  fi
  [ -n "$LIVE_REENABLE" ] && claude plugin enable "$LIVE_REENABLE" >/dev/null && echo "re-enabled $LIVE_REENABLE"
  LIVE_REENABLE='' LIVE_BACKUP='' LIVE_PID=''
  LIVE_PIDS=() LIVE_FILES=()
}

# One run of a mod's slash command, as a local session would run it. Prints
# the command's text.
live_command() {
  env -u CLAUDE_CODE_REMOTE -u CLAUDE_CODE_REMOTE_SESSION_ID \
    timeout 60 claude --plugin-dir "$LIVE_MOD" -p "/$1" 2>/dev/null
}

# A session in the background, the mod not loaded; LIVE_PID is its pid.
# Extra arguments go to claude (--allowedTools "Bash(sleep:*)" is added).
live_bg() {
  local prompt=$1; shift
  env -u CLAUDE_CODE_REMOTE -u CLAUDE_CODE_REMOTE_SESSION_ID \
    claude -p "$prompt" --allowedTools "Bash(sleep:*)" "$@" >/dev/null 2>&1 &
  LIVE_PID=$!
  LIVE_PIDS+=("$LIVE_PID")
}

# The same, outside this session's process tree; LIVE_PID is found from its
# session file, by the session id given with --resume or --session-id. A
# leftover file with the same id whose process is gone is skipped.
live_detached() { # <session id> <prompt> [claude args]
  local id=$1 prompt=$2; shift 2
  setsid -f env -u CLAUDE_CODE_REMOTE -u CLAUDE_CODE_REMOTE_SESSION_ID \
    claude -p "$prompt" --allowedTools "Bash(sleep:*)" "$@" >/dev/null 2>&1
  LIVE_PID=''
  local _ f pid
  for _ in $(seq 60); do
    for f in "$LIVE_SESSIONS"/*.json; do
      [ "$(live_field "$f" sessionId)" = "$id" ] || continue
      pid=$(live_field "$f" pid)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        LIVE_PID=$pid
        LIVE_PIDS+=("$LIVE_PID")
        return 0
      fi
    done
    sleep 1
  done
  return 1
}

# A field of a JSON file, or nothing.
live_field() {
  python3 -c "import json,sys;v=json.load(open(sys.argv[1])).get(sys.argv[2]);print('' if v is None else v)" "$1" "$2" 2>/dev/null
}

# Waits up to 60 s for a session's file to show a status.
live_wait_status() { # <pid> <status>
  local _
  for _ in $(seq 60); do
    [ "$(live_field "$LIVE_SESSIONS/$1.json" status)" = "$2" ] && return 0
    sleep 1
  done
  return 1
}

# Waits up to 60 s for a process to exit.
live_wait_gone() {
  local _
  for _ in $(seq 60); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done
  return 1
}

# A key of the mod's store as JSON ({} when unset): pipe it to python3 or jq.
live_store() {
  python3 - "$LIVE_STORE" "$(basename "$LIVE_MOD")" "$1" <<'EOF'
import glob, json, sys
for path in glob.glob(f'{sys.argv[1]}/{sys.argv[2]}_inline-*.json'):
    print(json.dumps(json.load(open(path)).get(sys.argv[3], {})))
    break
else:
    print('{}')
EOF
}
