# Dev Maestro - MASTER_PLAN.md Format Guide

Add this section to your project's `CLAUDE.md` to help Claude Code understand the MASTER_PLAN.md task format.

---

## MASTER_PLAN.md Task Format (MANDATORY)

Dev Maestro parses `docs/MASTER_PLAN.md` to display tasks on the Kanban board. Tasks MUST follow this exact format.

### Parsing Rules

| Rule | Requirement |
|------|-------------|
| **Heading Level** | Must be H3 (`###`) - not H1, H2, or H4 |
| **Task ID** | Must start with `TASK-` followed by digits (e.g., TASK-001) |
| **Colon** | Required after task ID: `TASK-XXX:` |
| **Completed Tasks** | Use strikethrough on ID: `~~TASK-XXX~~` |

### Status Markers to Kanban Columns

| Title Marker | Kanban Column |
|--------------|---------------|
| `(🔄 IN PROGRESS)` | In Progress |
| `(⏸️ PAUSED)` | Blocked |
| `(👀 REVIEW)` | Review |
| `(✅ DONE)` | Done |
| *(no marker)* | Backlog |

### Required Task Structure

```markdown
### TASK-XXX: Task Title (STATUS_EMOJI STATUS_TEXT)
**Status**: Status Text
**Priority**: High | Medium | Low
**Complexity**: High | Medium | Low

Description of the task...
```

### Correct Examples

```markdown
### TASK-001: Add user authentication
**Status**: Todo
**Priority**: High
**Complexity**: Medium

Implement JWT-based authentication for the API.

### TASK-002: Fix memory leak in dashboard (🔄 IN PROGRESS)
**Status**: In Progress
**Priority**: High
**Complexity**: Low

Memory leak identified in the chart component.

### ~~TASK-003~~: Setup CI/CD pipeline (✅ DONE)
**Status**: Done
**Priority**: Medium

GitHub Actions workflow for automated testing and deployment.
```

### Incorrect Examples (Will NOT Parse)

| Example | Problem |
|---------|---------|
| `## TASK-001: Title` | Wrong heading level (must be `###`) |
| `### Add feature` | Missing `TASK-XXX` prefix |
| `### TASK-001 Title` | Missing colon after ID |
| `### TASK-001: Done (✅ DONE)` | Completed tasks need strikethrough on ID |
| `#### TASK-001: Title` | Wrong heading level (H4 instead of H3) |

### Adding a New Task

1. Read `docs/MASTER_PLAN.md` to find the highest `TASK-XXX` number
2. Increment to get the next ID (e.g., TASK-042 → TASK-043)
3. Add the task under the appropriate section using the exact format above
4. New tasks should have NO status marker (they appear in Backlog)

```markdown
### TASK-043: New feature description
**Status**: Todo
**Priority**: Medium
**Complexity**: Low

Description of what needs to be done.
```

### Completing a Task

1. Add strikethrough to the task ID: `### TASK-XXX:` → `### ~~TASK-XXX~~:`
2. Add `(✅ DONE)` to the end of the title line
3. Update the Status field to `Done`

**Before:**
```markdown
### TASK-042: Implement feature X (🔄 IN PROGRESS)
**Status**: In Progress
```

**After:**
```markdown
### ~~TASK-042~~: Implement feature X (✅ DONE)
**Status**: Done
```

### Changing Task Status

To move a task between Kanban columns, update the status marker in the title:

| To Move To | Change Title To |
|------------|-----------------|
| Backlog | Remove status marker entirely |
| In Progress | Add `(🔄 IN PROGRESS)` |
| Blocked | Add `(⏸️ PAUSED)` |
| Review | Add `(👀 REVIEW)` |
| Done | Add strikethrough + `(✅ DONE)` |

---

## Claude Code Integration

### Option 1: MCP Server (Recommended)

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "dev-maestro": {
      "command": "node",
      "args": ["/home/YOUR_USER/.dev-maestro/mcp-server.js"],
      "env": {
        "DEV_MAESTRO_URL": "http://localhost:6010"
      }
    }
  }
}
```

Or run: `~/.dev-maestro/scripts/setup-mcp.sh /path/to/project`

This gives you these tools:
- `maestro_get_tasks` - Get all tasks (optionally filter by status)
- `maestro_get_task` - Get a specific task by ID
- `maestro_update_status` - Update task status
- `maestro_next_id` - Get next available task ID
- `maestro_health` - Get project health report
- `maestro_master_plan` - Get raw MASTER_PLAN.md content

### Option 2: Direct API Usage

If MCP is not available, Claude Code can interact with Dev Maestro via HTTP:

```bash
# Get all tasks
curl -s http://localhost:6010/api/master-plan

# Get next task ID
curl -s http://localhost:6010/api/next-id

# Update task status (backlog, in-progress, blocked, review, done)
curl -X POST http://localhost:6010/api/task/TASK-001/status \
  -H "Content-Type: application/json" \
  -d '{"status": "in-progress"}'

# Get project health
curl -s http://localhost:6010/api/health/quick
```

---

## Integration with Dev Maestro

Dev Maestro provides a Kanban dashboard at `http://localhost:6010` that:
- Parses your MASTER_PLAN.md in real-time
- Displays tasks in the correct columns based on status markers
- Supports drag-and-drop to update task status
- Auto-refreshes when the file changes

**Prerequisites:** Dev Maestro must be running (`cd ~/.dev-maestro && npm start`)

For more information: https://github.com/endlessblink/dev-maestro
