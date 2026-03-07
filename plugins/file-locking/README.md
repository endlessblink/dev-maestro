# Dev-Maestro File Locking Plugin

Multi-agent file locking system with deferred execution for coordinating Claude Code sessions.

## Quick Install

```bash
# From any project directory:
~/.dev-maestro/plugins/file-locking/install.sh [PROJECT_DIR]
```

## What It Does

- Prevents multiple Claude agents from editing the same file simultaneously
- **Deferred execution**: Blocked agents save edits to queue and work on other tasks
- Agents get notified when locks release (on next user prompt)
- Auto-expires stale locks after 4 hours
- No CPU usage while waiting (no polling/watching)

## Requirements

- Claude Code with hooks support
- `jq` for JSON parsing

## How It Works

```
Agent B tries to edit file.vue (locked by Agent A)
    │
    ▼
┌──────────────────────────────────────────┐
│  PreToolUse: task-lock-enforcer.sh       │
│                                          │
│  1. Detect lock by Agent A               │
│  2. Save edit to deferred queue          │
│  3. Exit 2 with guidance message         │
└──────────────────────────────────────────┘
    │
    ▼
Message: "DEFERRED: file.vue locked by TASK-123.
          Work on other tasks: `bd ready`"
    │
    ▼
(Agent B works on other tasks)
    │
    ▼
(Agent A completes, releases lock)
    │
    ▼
┌──────────────────────────────────────────┐
│  UserPromptSubmit: deferred-reminder.sh  │
│                                          │
│  Checks deferred queue                   │
│  Notifies: "file.vue now available!"     │
└──────────────────────────────────────────┘
    │
    ▼
Agent B retries edit → Success!
```

## Manual Setup

1. Copy hooks to project:
   ```bash
   cp ~/.dev-maestro/plugins/file-locking/task-lock-enforcer.sh \
      YOUR_PROJECT/.claude/hooks/
   cp ~/.dev-maestro/plugins/file-locking/deferred-reminder.sh \
      YOUR_PROJECT/.claude/hooks/
   chmod +x YOUR_PROJECT/.claude/hooks/*.sh
   ```

2. Add to `.claude/settings.json`:
   ```json
   {
     "hooks": {
       "PreToolUse": [{
         "hooks": [{
           "type": "command",
           "command": ".claude/hooks/task-lock-enforcer.sh"
         }]
       }],
       "UserPromptSubmit": [{
         "hooks": [{
           "type": "command",
           "command": ".claude/hooks/deferred-reminder.sh"
         }]
       }]
     }
   }
   ```

3. Create directories:
   ```bash
   mkdir -p YOUR_PROJECT/.claude/locks
   mkdir -p YOUR_PROJECT/.claude/deferred-queue
   echo "*.lock" > YOUR_PROJECT/.claude/locks/.gitignore
   echo "*.json" > YOUR_PROJECT/.claude/deferred-queue/.gitignore
   ```

4. Map files to tasks in `docs/MASTER_PLAN.md` (or configure custom path)

## Configuration

Edit the hook script to customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCK_EXPIRY_HOURS` | 4 | Auto-clear locks older than this |
| `MASTER_PLAN` | `docs/MASTER_PLAN.md` | Task-file mapping source |

## Data Formats

### Lock File (`.claude/locks/TASK-XXX.lock`)

```json
{
  "task_id": "TASK-123",
  "session_id": "abc123...",
  "timestamp": 1737578400,
  "locked_at": "2026-01-22 21:00:00",
  "files_touched": ["src/file.vue"]
}
```

### Deferred Queue (`.claude/deferred-queue/{session_id}.json`)

```json
{
  "session_id": "abc123...",
  "deferred_edits": [
    {
      "file": "src/file.vue",
      "blocked_by_task": "TASK-123",
      "blocked_by_session": "xyz789...",
      "tool_input": { /* original Edit params */ },
      "timestamp": 1737580000
    }
  ]
}
```

## Commands

```bash
# View active locks
ls -la YOUR_PROJECT/.claude/locks/

# View deferred queues
ls -la YOUR_PROJECT/.claude/deferred-queue/

# Force release specific lock
rm YOUR_PROJECT/.claude/locks/TASK-XXX.lock

# Clear all stale locks (older than 4 hours)
find YOUR_PROJECT/.claude/locks -name "*.lock" -mmin +240 -delete
```
