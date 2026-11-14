# Helpers for a data-level live check: real Claude Code sessions run against a
# copy of a mod, and the state its pane would draw from is read back. Source
# it, then write the scenario for the change at hand:
#
#   source .claude/skills/check-mod/live.sh
#   live_begin <mod folder>          # the copy to check; installed copy off
#   trap live_end EXIT               # always undo what live_begin did
#   live_bg "Use the Bash tool to run exactly: sleep 20. Then reply done."
#   live_wait_status "$LIVE_PID" busy
#   live_command sessions            # one run of /sessions: its hooks fire
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

# The copy of the mod to load, with an empty store. The installed copy of the
# same mod is turned off so it doesn't load twice; live_end turns it back on.
live_begin() {
  LIVE_MOD=$1
  local name; name=$(basename "$1")
  rm -f "$LIVE_STORE/$name"_inline-*.json
  if claude plugin list 2>/dev/null | grep -A3 "> $name@claude-code-mods" | grep -q 'enabled'; then
    claude plugin disable "$name@claude-code-mods" >/dev/null && LIVE_REENABLE="$name@claude-code-mods"
  fi
}

# A file the scenario creates, deleted by live_end.
live_file() { # <path> <content>
  printf '%s' "$2" >"$1" && LIVE_FILES+=("$1")
}

# Undoes live_begin: stops every session started here, deletes the files
# made with live_file and the test store, turns the installed copy back on.
live_end() {
  local pid f _
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
  [ -n "$LIVE_REENABLE" ] && claude plugin enable "$LIVE_REENABLE" >/dev/null && echo "re-enabled $LIVE_REENABLE"
  LIVE_REENABLE=''
}

# One run of a mod's slash command, as a local session would run it.
live_command() {
  env -u CLAUDE_CODE_REMOTE -u CLAUDE_CODE_REMOTE_SESSION_ID \
    timeout 60 claude --plugin-dir "$LIVE_MOD" -p "/$1" >/dev/null 2>&1
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
# session file, by the session id given with --resume or --session-id.
live_detached() { # <session id> <prompt> [claude args]
  local id=$1 prompt=$2; shift 2
  setsid -f env -u CLAUDE_CODE_REMOTE -u CLAUDE_CODE_REMOTE_SESSION_ID \
    claude -p "$prompt" --allowedTools "Bash(sleep:*)" "$@" >/dev/null 2>&1
  LIVE_PID=''
  local _ f
  for _ in $(seq 60); do
    for f in "$LIVE_SESSIONS"/*.json; do
      if [ "$(live_field "$f" sessionId)" = "$id" ]; then
        LIVE_PID=$(live_field "$f" pid)
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
  python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2]))" "$1" "$2" 2>/dev/null
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
