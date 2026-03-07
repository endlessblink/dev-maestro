# Dev Maestro

Dev Maestro is an orchestration dashboard and task management system for AI-assisted development projects. It provides a web dashboard, terminal UI, Claude Code skill integration, and agent management via the "Happy" system.

## Finding MASTER_PLAN.md

**Rule: Always read `.env` first** when looking for tasks, bugs, or MASTER_PLAN.md.

The `MASTER_PLAN_PATH` variable in `.env` points to the active project's plan file. This is an absolute path to an external project — Dev Maestro manages projects, it doesn't contain them.

Resolution order:
1. `MASTER_PLAN_PATH` environment variable
2. `projects.json` registry (match CWD to registered project roots)
3. `.env` file in this directory (`MASTER_PLAN_PATH=...`)
4. Relative paths: `docs/MASTER_PLAN.md`, `MASTER_PLAN.md`

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express API server (port 6010) — serves dashboard + REST API |
| `index.html` | Dashboard web UI (kanban board, health scanner, agent view) |
| `.env` | Configuration — `MASTER_PLAN_PATH`, `PORT`, memory safeguards |
| `projects.json` | Multi-project registry (name, root, masterPlan path, modules) |
| `local/config.json` | Local overrides for port, auto-update, update branch |
| `tui/` | Terminal UI (React/Ink) — card view, project-aware |
| `modules/` | Agent management modules (`happy-manager.js`, `happy-safety.js`) |
| `plugins/` | Plugin system |
| `scripts/` | Setup and health scanner scripts |
| `skills/` | Claude Code skill definitions |
| `data/` | Audit logs and operational data |

## REST API Endpoints

### Core
- `GET /api/status` — Server health and running state
- `GET /api/config` — Current configuration
- `POST /api/config/project` — Update project config
- `POST /api/config/reload` — Reload configuration from disk

### Tasks (from MASTER_PLAN.md)
- `GET /api/master-plan` — Full parsed MASTER_PLAN.md content
- `GET /api/next-id` — Get next available task ID
- `POST /api/task/:id/status` — Update task status
- `POST /api/task/:id/complexity` — Set task complexity
- `POST /api/task/:id` — Update task fields
- `POST /api/task/add` — Add a new task

### Health Scanner
- `GET /api/health` — Full health scan (async)
- `GET /api/health/quick` — Quick health check
- `GET /api/health/cached` — Return last cached scan results
- `GET /api/health/status` — Health scan status
- `POST /api/health/scan` — Trigger new health scan
- `GET /api/health/report` — Human-readable health report
- `GET /api/health/report/json` — Machine-readable health report

### Skills & Docs
- `GET /api/skills` — List available Claude Code skills
- `GET /api/docs` — List documentation files

### Beads (Agent Orchestration)
- `GET /api/beads/stats` — Dependency statistics
- `GET /api/beads/list` — List all beads (tasks)
- `GET /api/beads/ready` — Tasks with all deps resolved
- `GET /api/beads/deps/:id` — Dependencies for a specific task
- `GET /api/beads/graph` — Full dependency graph
- `GET /api/beads/supervisors` — List supervisors
- `POST /api/beads/claim/:id` — Claim a task (sets IN PROGRESS)
- `POST /api/beads/close/:id` — Close a task (sets DONE)
- `POST /api/beads/merge/:id` — Merge completed agent work
- `GET /api/beads/agents` — List active agents
- `GET /api/beads/agents/:id/stream` — Stream agent output (SSE)
- `POST /api/beads/agents/:id/stop` — Stop an agent
- `POST /api/beads/agents/:id/command` — Send command to agent

### Worktrees
- `GET /api/cleanup-worktrees` — List worktrees eligible for cleanup
- `POST /api/cleanup-worktrees` — Clean up stale worktrees

### Happy System (Human-Approval for Agent Tasks)
- `GET /api/happy/status` — Happy system status
- `GET /api/happy/sessions` — List all sessions
- `POST /api/happy/start` — Start a new happy session
- `POST /api/happy/stop/:id` — Stop a session
- `GET /api/happy/session/:id` — Get session details
- `GET /api/happy/session/:id/output` — Get session output
- `GET /api/happy/stream/:id` — Stream session output (SSE)
- `GET /api/happy/queue` — Approval queue
- `POST /api/happy/queue/:id/approve` — Approve a queued action
- `POST /api/happy/queue/:id/deny` — Deny a queued action
- `GET /api/happy/queue/stream` — Stream queue updates (SSE)
- `GET /api/happy/audit` — Audit log
- `GET /api/happy/config` — Happy system config
- `POST /api/happy/config` — Update happy system config
- `POST /api/happy/check` — Check if action requires approval
- `GET /api/happy/events` — SSE event stream for happy system

### Events
- `GET /api/events` — Server-sent events stream for dashboard updates
- `GET /api/deferred` — Deferred task queue

## Architecture Notes

- Dashboard is a single-page HTML app served by Express
- Server parses MASTER_PLAN.md on startup and watches for changes
- TUI is a separate Node.js app in `tui/` using React/Ink
- Projects are registered in `projects.json` and can be switched without restart
- Local overrides in `local/` directory are preserved across updates
- Claude binary is auto-discovered (env var → `~/.local/bin` → VS Code extension → `which`)
- Memory safeguards configured via `MAX_PARALLEL_AGENTS`, `MIN_MEMORY_GB` in `.env`
