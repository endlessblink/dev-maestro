#!/bin/bash
#
# Hook: Deferred Edit Reminder (UserPromptSubmit)
# Purpose: Check for available deferred edits when locks are released
# Exit 0 = Allow prompt (with optional notification)
#
# This hook runs on each user prompt and:
# 1. Finds this session's deferred queue file
# 2. Checks if any blocking locks have been released
# 3. If yes, outputs a reminder to retry the deferred edits
# 4. Cleans up completed deferred edits from queue
#

set -euo pipefail

# Configuration
QUEUE_DIR="${CLAUDE_PROJECT_DIR}/.claude/deferred-queue"
LOCKS_DIR="${CLAUDE_PROJECT_DIR}/.claude/locks"

# Read JSON input from stdin (with timeout)
INPUT=$(timeout 2 cat 2>/dev/null || echo '{}')

# Extract session ID
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')

# Skip if no session ID
[[ -z "$SESSION_ID" ]] && exit 0

# Find this session's queue file
QUEUE_FILE="$QUEUE_DIR/${SESSION_ID}.json"

# Skip if no queue file exists
[[ ! -f "$QUEUE_FILE" ]] && exit 0

# Check each deferred edit
READY_EDITS=()
STILL_BLOCKED=()

while IFS= read -r edit; do
  blocked_task=$(echo "$edit" | jq -r '.blocked_by_task')
  file=$(echo "$edit" | jq -r '.file')
  lock_file="$LOCKS_DIR/${blocked_task}.lock"

  # If lock no longer exists, edit is ready
  if [[ ! -f "$lock_file" ]]; then
    READY_EDITS+=("$file")
  else
    STILL_BLOCKED+=("$file")
  fi
done < <(jq -c '.deferred_edits[]' "$QUEUE_FILE" 2>/dev/null || echo "")

# Update queue file to remove ready edits
if [[ ${#READY_EDITS[@]} -gt 0 ]]; then
  # Rebuild queue with only still-blocked edits
  if [[ ${#STILL_BLOCKED[@]} -eq 0 ]]; then
    # All edits are ready - remove the queue file
    rm -f "$QUEUE_FILE"
  else
    # Keep only still-blocked edits by filtering on task
    TMP_FILE="${QUEUE_FILE}.tmp"
    # Build a jq filter for tasks that are still blocked
    BLOCKED_TASKS=""
    while IFS= read -r edit; do
      task=$(echo "$edit" | jq -r '.blocked_by_task')
      lock_file="$LOCKS_DIR/${task}.lock"
      if [[ -f "$lock_file" ]]; then
        if [[ -n "$BLOCKED_TASKS" ]]; then
          BLOCKED_TASKS="$BLOCKED_TASKS, \"$task\""
        else
          BLOCKED_TASKS="\"$task\""
        fi
      fi
    done < <(jq -c '.deferred_edits[]' "$QUEUE_FILE" 2>/dev/null)

    if [[ -n "$BLOCKED_TASKS" ]]; then
      jq --argjson tasks "[$BLOCKED_TASKS]" '
        .deferred_edits |= map(select(.blocked_by_task as $t | $tasks | index($t)))
      ' "$QUEUE_FILE" > "$TMP_FILE" 2>/dev/null && mv "$TMP_FILE" "$QUEUE_FILE"
    else
      rm -f "$QUEUE_FILE"
    fi
  fi

  # Check if queue file still exists and is empty
  if [[ -f "$QUEUE_FILE" ]]; then
    REMAINING=$(jq '.deferred_edits | length' "$QUEUE_FILE" 2>/dev/null || echo "0")
    if [[ "$REMAINING" == "0" ]]; then
      rm -f "$QUEUE_FILE"
    fi
  fi
fi

# Notify about ready edits
if [[ ${#READY_EDITS[@]} -gt 0 ]]; then
  cat << EOF
<user-prompt-submit-hook>
DEFERRED EDITS NOW AVAILABLE:

The following files are no longer locked:
$(printf '  - %s\n' "${READY_EDITS[@]}")

You can now retry your edits to these files.
The original edits were saved - you may need to re-read the files first to see current state.
</user-prompt-submit-hook>
EOF
fi

# Always allow the prompt to proceed
exit 0
