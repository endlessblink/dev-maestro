#!/usr/bin/env bash
# changelog-capture.sh — Claude Code PostToolUse/SessionStart/Stop hook
# Appends a JSONL entry to ~/.dev-maestro/data/changelog/<project-slug>.jsonl
# MUST always exit 0. Must be fast (<100ms). No network calls.

set -euo pipefail

# Trap everything — never let this hook cause Claude Code to abort
trap 'exit 0' EXIT ERR INT TERM

# Guard: jq is required
if ! command -v jq &>/dev/null; then
  exit 0
fi

# Read all of stdin
PAYLOAD="$(cat)"

# Guard: empty payload
if [[ -z "$PAYLOAD" ]]; then
  exit 0
fi

# Parse fields via jq (if any parse fails, jq returns null which is fine)
TOOL="$(echo "$PAYLOAD" | jq -r '.tool_name // "unknown"')"
EVENT="$(echo "$PAYLOAD" | jq -r '.hook_event_name // "unknown"')"
SID="$(echo "$PAYLOAD" | jq -r '.session_id // ""')"
TID="$(echo "$PAYLOAD" | jq -r '.tool_use_id // ""')"
CWD="$(echo "$PAYLOAD" | jq -r '.cwd // ""')"

# Derive project slug from cwd basename
if [[ -n "$CWD" ]]; then
  PROJECT="$(basename "$CWD")"
else
  PROJECT="unknown"
fi

# Capture git branch for the cwd
BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

# Extract file_path for Write/Edit/Read tools
FILE_VAL="$(echo "$PAYLOAD" | jq -r '
  if .tool_name == "Write" or .tool_name == "Edit" or .tool_name == "Read"
  then (.tool_input.file_path // "null")
  else "null"
  end')"

# Build file JSON arg (null or quoted string)
if [[ "$FILE_VAL" == "null" ]]; then
  FILE_JSON='null'
else
  FILE_JSON="$(printf '%s' "$FILE_VAL" | jq -Rs '.')"
fi

# Extract command for Bash tool, truncated to 200 chars
CMD_RAW="$(echo "$PAYLOAD" | jq -r '
  if .tool_name == "Bash"
  then (.tool_input.command // "null")
  else "null"
  end')"

if [[ "$CMD_RAW" == "null" ]]; then
  CMD_JSON='null'
else
  CMD_JSON="$(printf '%s' "${CMD_RAW:0:200}" | jq -Rs '.')"
fi

# Summary: tool_input as compact JSON string, truncated to 500 chars
SUMMARY_RAW="$(echo "$PAYLOAD" | jq -c '.tool_input // {}')"
SUMMARY="${SUMMARY_RAW:0:500}"

# Timestamp
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Output directory and file
DATA_DIR="${HOME}/.dev-maestro/data/changelog"
mkdir -p "$DATA_DIR"
PROJECT_DIR="${DATA_DIR}/${PROJECT}"
mkdir -p "$PROJECT_DIR"
TODAY="$(date -u +%Y-%m-%d)"
LOG_FILE="${PROJECT_DIR}/${TODAY}.jsonl"

# Build the JSONL entry using jq to ensure valid JSON output
ENTRY="$(jq -cn \
  --arg ts "$TS" \
  --arg sid "$SID" \
  --arg tid "$TID" \
  --arg tool "$TOOL" \
  --arg event "$EVENT" \
  --arg project "$PROJECT" \
  --arg cwd "$CWD" \
  --argjson file "$FILE_JSON" \
  --argjson cmd "$CMD_JSON" \
  --arg summary "$SUMMARY" \
  --arg agent "conductor" \
  --arg branch "$BRANCH" \
  '{ts:$ts,sid:$sid,tid:$tid,tool:$tool,event:$event,project:$project,cwd:$cwd,file:$file,cmd:$cmd,summary:$summary,agent:$agent,branch:$branch}'
)"

echo "$ENTRY" >> "$LOG_FILE"

# For SessionStart events, also append to the sessions index
if [[ "$EVENT" == "SessionStart" ]]; then
  SESSIONS_FILE="${DATA_DIR}/_sessions.jsonl"
  echo "$ENTRY" >> "$SESSIONS_FILE"
fi

exit 0
