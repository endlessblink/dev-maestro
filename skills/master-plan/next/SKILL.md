---
name: next
description: Analyze and pick the next task to work on. Reads MASTER_PLAN.md, scores tasks by priority and status, and presents interactive selection. Use when starting a session or deciding what to tackle next.
---

# What's Next?

Analyze MASTER_PLAN.md tasks, score by priority/status, and let the user pick interactively.

## Triggers

- `/master-plan:next` - Main command
- "what should I work on", "pick a task", "next task", "what's next"

## Arguments

| Argument | Filter |
|----------|--------|
| `bugs` | Only BUG-XXX tasks |
| `progress` | Only IN PROGRESS tasks |
| `planned` | Only PLANNED (backlog) tasks |
| `review` | Only REVIEW tasks |
| `active` | IN PROGRESS + REVIEW |
| `all` | Include DONE tasks |

Example: `/master-plan:next bugs` or `/master-plan:next planned`

## Workflow

### Step 1: Find MASTER_PLAN.md

Resolve the MASTER_PLAN.md path using this priority order:

1. **Env var**: If `MASTER_PLAN_PATH` environment variable is set, use it
2. **Project registry**: Read `~/.dev-maestro/projects.json` — if the current working directory matches (or is a subdirectory of) a registered project's `root`, use its `masterPlan` path
3. **Local .env**: Read `.env` in CWD for a line starting with `MASTER_PLAN_PATH=` and use the value after `=`
4. **Dev Maestro .env**: Read `~/.dev-maestro/.env` for a line starting with `MASTER_PLAN_PATH=` and use the value after `=`
5. **Relative paths** (fallback):
   - `docs/MASTER_PLAN.md`
   - `MASTER_PLAN.md`
   - `master-plan.md`
   - `docs/master-plan.md`

For `.env` files, parse lines starting with `MASTER_PLAN_PATH=` and use the value after `=` (strip surrounding quotes if present).
For `projects.json`, parse the JSON and check if any project's `root` is a prefix of the current working directory.

If not found after all steps, tell the user: "No MASTER_PLAN.md found. Run `/task` to create your first task, or set `MASTER_PLAN_PATH` in your environment."

### Step 2: Parse Tasks

Read the file and extract tasks from `###` headers matching this pattern:

```
### [optional ~~]TASK-123[optional ~~]: Title (STATUS)
```

Regex: `^###\s+(~~)?((TASK|BUG|FEATURE|ROAD|IDEA|ISSUE|INQUIRY)-\d+)(~~)?:\s*(.+?)\s*\(([^)]+)\)`

For each match, extract:
- **ID**: e.g., `TASK-123`, `BUG-456`
- **Title**: The text after `: ` and before ` (`
- **Status**: Text in parentheses. Normalize:
  - Contains "DONE", "COMPLETE", "FIXED", "✅", or has strikethrough → `DONE`
  - Contains "IN PROGRESS", "🔄" → `IN PROGRESS`
  - Contains "REVIEW", "👀" → `REVIEW`
  - Contains "PAUSED", "⏸️" → `PAUSED`
  - Otherwise → `PLANNED`
- **Priority**: Look in the lines following the header for `**Priority**: P0-P3`. Default to P2 if not found.

### Step 3: Check for Active Work

Look for IN PROGRESS tasks first — these should be finished before starting new work.

Also check git status:
```bash
git status --short
```

If uncommitted changes exist, mention: "You have uncommitted changes — consider committing or running `/master-plan:save` first."

### Step 4: Sort and Filter

**Default sort order** (what to START next):
1. PLANNED first, then REVIEW, IN PROGRESS, PAUSED, DONE last
2. Within same status: P0 → P1 → P2 → P3

**If `$ARGUMENTS` contains a filter** (bugs, progress, planned, review, active), apply it before sorting.

**Exclude DONE tasks** unless `$ARGUMENTS` contains `all`.

### Step 5: Present Interactive Selection

Use `AskUserQuestion` to let user pick from the top tasks:

```
AskUserQuestion({
  questions: [{
    question: "Which task would you like to work on?",
    header: "Task",
    multiSelect: false,
    options: [
      // Top 4 tasks, formatted as:
      { label: "TASK-XXX: Title here", description: "P0 · IN PROGRESS" },
      { label: "BUG-YYY: Another task", description: "P1 · PLANNED" },
      // ...
    ]
  }]
})
```

**Option formatting:**
- Label: `{ID}: {title (max 40 chars)}`
- Description: `{priority} · {status}`

If there are IN PROGRESS tasks, always show them first with a note: "You have N task(s) in progress."

### Step 6: Show Task Details

When user selects a task, show the full section from MASTER_PLAN.md:
- ID, title, status, priority
- Description (everything between this `###` header and the next `###` or `##`)

### Step 7: Offer Actions

After showing task details, ask:

```
AskUserQuestion({
  questions: [{
    question: "What would you like to do?",
    header: "Action",
    multiSelect: false,
    options: [
      { label: "Start working on this", description: "Update status to IN PROGRESS" },
      { label: "Pick a different task", description: "Go back to task list" },
      { label: "Just show context", description: "No status change" }
    ]
  }]
})
```

If "Start working on this" is selected:
1. Update the task's status to `IN PROGRESS` in MASTER_PLAN.md (all locations — see update rules below)
2. Confirm: "Started TASK-XXX. Ready to begin implementation."

## MASTER_PLAN.md Update Rules

Tasks may appear in multiple locations. When updating status, check ALL of:

1. **Summary/Roadmap table** — Update the status column
2. **Detailed `###` section header** — Update `(STATUS)` in parentheses
3. **Subtask bullet points** — Add strikethrough + ✅ if marking DONE

Always verify with a grep after updating.

## Rules

1. **Finish before starting** — Always highlight IN PROGRESS tasks first
2. **P0 trumps all** — Critical issues come first regardless of status
3. **Interactive selection** — Always use AskUserQuestion, never just print a list
4. **Context on selection** — Always show full task details when picked
5. **Action oriented** — Offer to start work immediately
