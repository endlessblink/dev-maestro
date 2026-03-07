---
name: maestro
description: Launch Dev Maestro dashboard or TUI from within Claude Code. Start the server, open the browser, check status, or launch TUI in tmux. Use when you want to view the kanban board, check project health, or manage tasks visually.
---

# Dev Maestro Launcher

Start, stop, and interact with the Dev Maestro dashboard and TUI from within Claude Code.

## Triggers

- `/master-plan:maestro` - Main command (interactive)
- "open maestro", "launch dashboard", "start maestro", "show kanban"

## Arguments

| Argument | Action |
|----------|--------|
| (none) | Smart launch: check status, start if needed, open browser |
| `status` | Show dashboard status and active project |
| `start` | Start dashboard server in background |
| `stop` | Stop dashboard server |
| `open` | Open dashboard in browser (starts server if needed) |
| `tui` | Launch TUI in a tmux pane (starts server if needed) |
| `switch` | Show projects and switch active project |
| `sync` | Re-sync tasks from MASTER_PLAN.md into SQLite |

## Workflow

### Step 1: Determine Action

Parse the argument. Default (no argument) = smart launch.

### Step 2: Check Server Status

```bash
curl -s http://localhost:6010/api/status 2>/dev/null
```

If the response has `"running": true`, the server is up. Extract version, project path, and uptime.

### Step 3: Execute Action

#### `status` — Show Info
Run the status check and display:
- Server: running/stopped, port, version, uptime
- Active project name and MASTER_PLAN.md path
- Task stats: `curl -s http://localhost:6010/api/tasks/stats`
- Registered projects: `curl -s http://localhost:6010/api/projects`

Format as a clean summary for the user.

#### `start` — Start Server
If server is not running:
```bash
cd ~/.dev-maestro && node server.js > /tmp/maestro-server.log 2>&1 &
```
Wait up to 5 seconds for it to respond, then confirm with status.

#### `stop` — Stop Server
```bash
lsof -ti:6010 | xargs kill 2>/dev/null
```
Confirm it's stopped.

#### `open` — Open Dashboard in Browser
Start server if needed (see `start`), then:
```bash
xdg-open http://localhost:6010 2>/dev/null &
```
Or on macOS: `open http://localhost:6010`

Tell the user the dashboard is open at http://localhost:6010.

#### `tui` — Launch TUI in Tmux
Check if we're inside tmux:
```bash
[ -n "$TMUX" ] && echo "in tmux" || echo "not in tmux"
```

If in tmux, create a new pane:
```bash
tmux split-window -h "cd ~/.dev-maestro && node tui/src/index.js"
```

If not in tmux, tell the user to run `maestro tui` in their terminal instead.

Always start the dashboard server first if not running (TUI uses the REST API).

#### `switch` — Switch Active Project
1. Fetch projects: `curl -s http://localhost:6010/api/projects`
2. Show the list to the user with AskUserQuestion, letting them pick
3. Activate: `curl -X POST http://localhost:6010/api/projects/{name}/activate`
4. Confirm the switch and show new project info

#### `sync` — Re-sync Tasks
```bash
curl -X POST http://localhost:6010/api/tasks/sync
```
Show how many tasks were synced.

#### Default (no argument) — Smart Launch
1. Check if server is running
2. If not running, start it
3. Show status summary (project, task counts)
4. Open dashboard in browser
5. Tell user: "Dashboard is at http://localhost:6010. Run `maestro tui` in terminal for the board view."

### Step 4: Report

Always end with a brief, clean status message. Include the dashboard URL if relevant.
