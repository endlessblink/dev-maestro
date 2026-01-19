# Dev Maestro - AI Agent Integration Guide

This guide explains how AI agents (Claude Code, Cursor, Copilot, etc.) can programmatically use Dev Maestro without human intervention.

---

## ONE-LINER BOOTSTRAP (Recommended)

**For AI agents - use this single command to install AND configure:**

```bash
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/scripts/bootstrap.sh | bash -s -- "$(pwd)"
```

This will:
1. Clone the dev-maestro repository if not installed
2. Install npm dependencies
3. Configure it for the current project (finds MASTER_PLAN.md automatically)
4. Create `maestro.sh` launcher in your project

**To also start the server:**
```bash
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/scripts/bootstrap.sh | bash -s -- "$(pwd)" --start
```

---

## Quick Reference

| Task | Command |
|------|---------|
| **Bootstrap (install + configure)** | `curl -sSL .../bootstrap.sh \| bash -s -- "$(pwd)"` |
| **Check if running** | `curl -s http://localhost:6010/api/status` |
| **Start server** | `./maestro.sh` or `cd ~/.dev-maestro && npm start` |
| **Get tasks** | `curl -s http://localhost:6010/api/tasks` |
| **Change project** | `curl -X POST http://localhost:6010/api/config/project -H "Content-Type: application/json" -d '{"path":"..."}'` |

---

## Step-by-Step Setup (Alternative)

### 1. Check if Dev Maestro is Installed

```bash
[ -d "$HOME/.dev-maestro" ] && echo "installed" || echo "not installed"
```

### 2. Install if Needed

```bash
git clone --depth 1 https://github.com/endlessblink/dev-maestro.git ~/.dev-maestro
cd ~/.dev-maestro && npm install
```

### 3. Configure for Your Project

```bash
~/.dev-maestro/scripts/setup-project.sh /path/to/project
```

### 4. Start the Server

```bash
cd ~/.dev-maestro && npm start &
```

---

## Runtime Configuration (Server Already Running)

Change project without restart:
```bash
curl -X POST http://localhost:6010/api/config/project \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/project"}'
```

---

## Complete API Reference

### Status & Health

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Check if running, get current project |
| `/api/config` | GET | Get full configuration |

**Example: Check Status**
```bash
curl -s http://localhost:6010/api/status
```
```json
{
  "running": true,
  "name": "Dev Maestro",
  "version": "1.0.0",
  "port": "6010",
  "project": "/path/to/project",
  "masterPlanPath": "/path/to/project/docs/MASTER_PLAN.md",
  "uptime": 3600,
  "url": "http://localhost:6010"
}
```

### Configuration (Runtime)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/config` | GET | Get current configuration |
| `/api/config/project` | POST | Change project at runtime |
| `/api/config/reload` | POST | Reload config from .env file |

**Example: Change Project**
```bash
curl -X POST http://localhost:6010/api/config/project \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/myproject"}'
```
```json
{
  "status": "ok",
  "message": "Project configured successfully",
  "masterPlanPath": "/home/user/myproject/docs/MASTER_PLAN.md",
  "projectRoot": "/home/user/myproject"
}
```

### MASTER_PLAN.md Operations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/master-plan` | GET | Get full MASTER_PLAN.md content |
| `/api/tasks` | GET | Get parsed tasks list |
| `/api/next-id` | GET | Get next available task ID |
| `/api/task/:id/status` | POST | Update task status |

**Example: Get Tasks**
```bash
curl -s http://localhost:6010/api/tasks
```

**Example: Get Next ID**
```bash
curl -s "http://localhost:6010/api/next-id?prefix=TASK"
```
```json
{"prefix": "TASK", "nextId": "TASK-328"}
```

**Example: Update Task Status**
```bash
curl -X POST http://localhost:6010/api/task/TASK-100/status \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress"}'
```

---

## Shell Script Reference

### setup-project.sh

Non-interactive project setup script. Returns JSON output for easy parsing.

**Usage:**
```bash
~/.dev-maestro/scripts/setup-project.sh /path/to/project
~/.dev-maestro/scripts/setup-project.sh /path/to/MASTER_PLAN.md
~/.dev-maestro/scripts/setup-project.sh --current
```

**Exit Codes:**
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Invalid arguments |
| 2 | Project/file not found |
| 3 | Configuration error |

**Output (JSON):**
```json
{
  "status": "ok",
  "message": "Project configured successfully",
  "projectRoot": "/path/to/project",
  "masterPlanPath": "/path/to/project/docs/MASTER_PLAN.md",
  "installDir": "/home/user/.dev-maestro",
  "serverUrl": "http://localhost:6010",
  "apiStatus": "http://localhost:6010/api/status"
}
```

---

## Common AI Agent Workflows

### Workflow 1: First-time Setup

```bash
# 1. Install Dev Maestro (if needed)
if [ ! -d "$HOME/.dev-maestro" ]; then
  curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash -s -- --non-interactive
fi

# 2. Configure for this project
~/.dev-maestro/scripts/setup-project.sh "$(pwd)"

# 3. Start the server
cd ~/.dev-maestro && npm start &

# 4. Wait for server to be ready
sleep 2
curl -s http://localhost:6010/api/status
```

### Workflow 2: Switch to Different Project (Server Running)

```bash
# Use runtime API - no restart needed
curl -X POST http://localhost:6010/api/config/project \
  -H "Content-Type: application/json" \
  -d "{\"path\": \"$(pwd)\"}"
```

### Workflow 3: Get Tasks and Update Status

```bash
# Get all tasks
TASKS=$(curl -s http://localhost:6010/api/tasks)

# Find task by ID and update
curl -X POST http://localhost:6010/api/task/TASK-100/status \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

### Workflow 4: Create New Task

```bash
# 1. Get next ID
NEXT_ID=$(curl -s "http://localhost:6010/api/next-id?prefix=TASK" | jq -r '.nextId')

# 2. Add to MASTER_PLAN.md (agent should edit the file directly)
# The task format depends on your MASTER_PLAN.md structure
```

---

## Integration Patterns

### For Claude Code

Add to your project's `CLAUDE.md`:

```markdown
## Dev Maestro Integration

Dev Maestro provides task tracking via MASTER_PLAN.md.

**Check if running:**
\`\`\`bash
curl -s http://localhost:6010/api/status | grep -q '"running":true'
\`\`\`

**Start if needed:**
\`\`\`bash
~/.dev-maestro/scripts/setup-project.sh "$(pwd)" && cd ~/.dev-maestro && npm start &
\`\`\`

**Get tasks:** `curl -s http://localhost:6010/api/tasks`
**Update task:** `curl -X POST http://localhost:6010/api/task/TASK-XXX/status -H "Content-Type: application/json" -d '{"status": "completed"}'`
```

### For MCP Integration

Dev Maestro can be used as an MCP server. See `.mcp.json` in your project root if configured.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEV_MAESTRO_DIR` | `~/.dev-maestro` | Installation directory |
| `MASTER_PLAN_PATH` | (auto-detected) | Path to MASTER_PLAN.md |

---

## Error Handling

### Common Errors and Solutions

**Server not running:**
```json
{"error": "connect ECONNREFUSED"}
```
Solution: Start the server with `cd ~/.dev-maestro && npm start`

**Project not found:**
```json
{"error": "Could not find MASTER_PLAN.md in project"}
```
Solution: Ensure MASTER_PLAN.md exists in project root or docs/ subdirectory

**Port in use:**
```
Error: listen EADDRINUSE: address already in use :::6010
```
Solution: Kill existing process or use different port via `local/config.json`

---

## File Locations

| Path | Purpose |
|------|---------|
| `~/.dev-maestro/` | Installation directory |
| `~/.dev-maestro/.env` | Environment configuration |
| `~/.dev-maestro/local/config.json` | User preferences (preserved on update) |
| `~/.dev-maestro/scripts/setup-project.sh` | Non-interactive setup script |
| `PROJECT/.dev-maestro.json` | Project marker file |
| `PROJECT/maestro.sh` | Project-specific launcher |
