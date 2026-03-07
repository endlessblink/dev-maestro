#!/bin/bash
#
# Hook: Task Lock Enforcer (PreToolUse)
# Purpose: Block edits to files owned by IN_PROGRESS tasks locked by another session
# Exit 2 = Block the tool call with error message
# Exit 0 = Allow the tool call
#
# This hook implements file-based locking for multi-instance coordination:
# 1. Checks if edited file belongs to a tracked MASTER_PLAN task
# 2. If task is locked by another session -> BLOCK (exit 2)
# 3. If task is not locked -> Acquire lock and ALLOW (exit 0)
#

set -euo pipefail

# Configuration
LOCKS_DIR="${CLAUDE_PROJECT_DIR}/.claude/locks"
MASTER_PLAN="${CLAUDE_PROJECT_DIR}/docs/MASTER_PLAN.md"
LOCK_EXPIRY_HOURS=4  # Stale locks older than this are auto-cleared

# Ensure locks directory exists
mkdir -p "$LOCKS_DIR"

# Read JSON input from stdin (with timeout to prevent freeze in Zellij)
INPUT=$(timeout 2 cat 2>/dev/null || echo '{}')

# Extract data from hook input
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only apply to Edit and Write tools
if [[ "$TOOL_NAME" != "Edit" ]] && [[ "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

# Skip if no file path
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip non-source files (configs, tests, docs don't indicate active task work)
if [[ "$FILE_PATH" == *".json" ]] || [[ "$FILE_PATH" == *".md" ]] || [[ "$FILE_PATH" == *".sh" ]] || [[ "$FILE_PATH" == *".lock" ]]; then
  exit 0
fi

# Skip if MASTER_PLAN doesn't exist
if [[ ! -f "$MASTER_PLAN" ]]; then
  exit 0
fi

# Get just the filename for matching
FILENAME=$(basename "$FILE_PATH")

# Function to clean up stale locks
cleanup_stale_locks() {
  local current_time
  current_time=$(date +%s)
  local expiry_seconds=$((LOCK_EXPIRY_HOURS * 3600))

  # Use find instead of glob to handle empty directory case
  while IFS= read -r -d '' lock_file; do
    if [[ -f "$lock_file" ]]; then
      local lock_time
      lock_time=$(jq -r '.timestamp // 0' "$lock_file" 2>/dev/null || echo "0")
      local age=$((current_time - lock_time))
      if [[ $age -gt $expiry_seconds ]]; then
        rm -f "$lock_file"
      fi
    fi
  done < <(find "$LOCKS_DIR" -maxdepth 1 -name "*.lock" -print0 2>/dev/null)
}

# Function to find matching task for a file
find_matching_task() {
  local file_path="$1"
  local filename="$2"
  local matching_task=""
  local task_status=""

  while IFS= read -r line; do
    # Skip non-table rows and header rows
    if [[ ! "$line" =~ ^\|.*TASK-[0-9]+ ]]; then
      continue
    fi

    # Extract task ID (handle strikethrough for done tasks)
    local task_id
    task_id=$(echo "$line" | grep -oE '(~~)?TASK-[0-9]+(~~)?' | head -1 | tr -d '~')

    # Skip done tasks (strikethrough) - handle both ~~TASK-XXX~~ and ~~**TASK-XXX**~~
    if [[ "$line" =~ ~~\*?\*?TASK-[0-9]+\*?\*?~~ ]]; then
      continue
    fi

    # Extract status (2nd column after ID)
    task_status=$(echo "$line" | cut -d'|' -f3 | xargs)

    # Extract primary files column (3rd column after ID)
    local primary_files
    primary_files=$(echo "$line" | cut -d'|' -f4 | tr -d '`' | xargs)

    # Check if edited file matches any pattern in Primary Files
    for pattern in $(echo "$primary_files" | tr ',' ' '); do
      pattern=$(echo "$pattern" | xargs)  # trim whitespace
      [[ -z "$pattern" ]] && continue

      # Direct filename match
      if [[ "$filename" == "$pattern" ]]; then
        echo "$task_id|$task_status"
        return 0
      fi

      # Glob pattern match (e.g., *.stories.ts, src/stores/*.ts)
      if [[ "$pattern" == *"*"* ]]; then
        # Convert glob to regex
        local regex
        regex=$(echo "$pattern" | sed 's/\./\\./g' | sed 's/\*/.*/g')
        if echo "$filename" | grep -qE "^$regex$" 2>/dev/null; then
          echo "$task_id|$task_status"
          return 0
        fi
        # Also check full path for directory patterns
        if echo "$file_path" | grep -qE "$regex" 2>/dev/null; then
          echo "$task_id|$task_status"
          return 0
        fi
      fi
    done
  done < "$MASTER_PLAN"

  echo ""
  return 1
}

# Function to check if task is locked by another session
check_lock() {
  local task_id="$1"
  local lock_file="$LOCKS_DIR/${task_id}.lock"

  if [[ -f "$lock_file" ]]; then
    local locked_session
    locked_session=$(jq -r '.session_id // ""' "$lock_file" 2>/dev/null || echo "")
    if [[ -n "$locked_session" ]] && [[ "$locked_session" != "$SESSION_ID" ]]; then
      # Locked by another session
      local locked_by
      local locked_at
      locked_by=$(jq -r '.session_id' "$lock_file" 2>/dev/null)
      locked_at=$(jq -r '.locked_at // "unknown"' "$lock_file" 2>/dev/null)
      echo "$locked_by|$locked_at"
      return 0
    fi
  fi
  return 1
}

# Function to acquire lock
acquire_lock() {
  local task_id="$1"
  local lock_file="$LOCKS_DIR/${task_id}.lock"
  local current_time
  current_time=$(date +%s)
  local human_time
  human_time=$(date '+%Y-%m-%d %H:%M:%S')

  cat > "$lock_file" << EOF
{
  "task_id": "$task_id",
  "session_id": "$SESSION_ID",
  "timestamp": $current_time,
  "locked_at": "$human_time",
  "files_touched": ["$FILE_PATH"]
}
EOF
}

# Main logic
cleanup_stale_locks

# Find if this file belongs to a tracked task
TASK_INFO=$(find_matching_task "$FILE_PATH" "$FILENAME" || echo "")

if [[ -z "$TASK_INFO" ]]; then
  # File doesn't belong to any tracked task, allow edit
  exit 0
fi

# Parse task info
TASK_ID=$(echo "$TASK_INFO" | cut -d'|' -f1)
TASK_STATUS=$(echo "$TASK_INFO" | cut -d'|' -f2)

# Check if task is locked by another session
LOCK_INFO=$(check_lock "$TASK_ID" || echo "")

if [[ -n "$LOCK_INFO" ]]; then
  # Task is locked by another session - DEFER AND WORK ON OTHER TASKS
  LOCKED_BY=$(echo "$LOCK_INFO" | cut -d'|' -f1)
  LOCKED_AT=$(echo "$LOCK_INFO" | cut -d'|' -f2)
  LOCK_FILE="$LOCKS_DIR/${TASK_ID}.lock"

  # Configuration
  DEFERRED_QUEUE_DIR="${CLAUDE_PROJECT_DIR}/.claude/deferred-queue"

  # Create deferred queue directory if needed
  mkdir -p "$DEFERRED_QUEUE_DIR"

  # Save deferred edit to queue
  QUEUE_FILE="$DEFERRED_QUEUE_DIR/${SESSION_ID}.json"
  CURRENT_TIME=$(date +%s)
  TOOL_INPUT_JSON=$(echo "$INPUT" | jq -c '.tool_input // {}')

  # Initialize queue file if it doesn't exist
  if [[ ! -f "$QUEUE_FILE" ]]; then
    echo '{"session_id":"'"$SESSION_ID"'","deferred_edits":[]}' > "$QUEUE_FILE"
  fi

  # Append this deferred edit to the queue
  jq --arg file "$FILE_PATH" \
     --arg task "$TASK_ID" \
     --arg blocked_session "$LOCKED_BY" \
     --argjson input "$TOOL_INPUT_JSON" \
     --argjson ts "$CURRENT_TIME" \
     '.deferred_edits += [{
       file: $file,
       blocked_by_task: $task,
       blocked_by_session: $blocked_session,
       tool_input: $input,
       timestamp: $ts
     }]' "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"

  # Exit with guidance message - DO NOT WAIT
  cat >&2 << EOF
📋 DEFERRED: Edit to $FILENAME queued (blocked by $TASK_ID)

The file is currently locked by session ${LOCKED_BY:0:8}... (since $LOCKED_AT).
Your edit has been saved to the deferred queue.

NEXT STEPS:
1. Work on other available tasks: \`bd ready\`
2. You'll be notified when $TASK_ID completes
3. Then retry your edit to $FILENAME

Deferred edit saved to: .claude/deferred-queue/${SESSION_ID}.json
EOF

  exit 2
fi

# Task is not locked or locked by this session - acquire/refresh lock and allow
acquire_lock "$TASK_ID"

# If task was not IN_PROGRESS, we should note that we're starting work
if [[ "$TASK_STATUS" != "IN_PROGRESS" ]] && [[ "$TASK_STATUS" != *"MONITORING"* ]]; then
  # Output context about acquiring the lock (shown to Claude in verbose mode)
  echo "TASK LOCK: Acquired lock for $TASK_ID (editing $FILENAME). Status will be updated to IN_PROGRESS."
fi

exit 0
