# Watchpost — Developer Guide & API Reference

Watchpost is a local AI orchestration dashboard that tracks tasks, health, changelogs, and dependencies across all projects.

## Project Scope
- Server installation: `~/.watchpost/`
- Projects registry: `~/.watchpost/projects.json`
- Changelog DB (all sessions): `~/.watchpost/data/changelog.db`
- Per-project task DB: `.watchpost/db.sqlite` (in project root)

## Command Line Interface (CLI)
`watchpost` is available at `~/.local/bin/watchpost`.
Commands: `tui`, `dashboard`, `status`, `stop`, `install`, `archive`, `discover`, `help`.

## Key API Endpoints (port 6010)

Always pass the current repository path as the `cwd` query parameter to scope commands:
`curl -sG --data-urlencode "cwd=$(pwd)" http://localhost:6010/api/status`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/discover` | GET | Full API manifest with all endpoints, CLI commands, and data locations |
| `/api/status` | GET | Active project, server health, uptime |
| `/api/projects` | GET | All registered projects with paths and MASTER_PLAN locations |
| `/api/master-plan` | GET | Parsed MASTER_PLAN.md for the current repo |
| `/api/next-id` | GET | Next available task ID for the current repo |
| `/api/beads/ready` | GET | Tasks with all deps resolved — ready to work on |
| `/api/beads/graph` | GET | Full dependency graph |
| `/api/health/quick` | GET | Quick project health assessment |
| `/api/health/report/json` | GET | Detailed health report (machine-readable) |
| `/api/skills` | GET | Available Claude Code skills |
| `/api/task/add` | POST | Add a new task |
| `/api/task/:id/status` | POST | Update task status |
| `/api/beads/claim/:id` | POST | Claim a task (sets IN PROGRESS) |
| `/api/beads/close/:id` | POST | Close a task (sets DONE) |
| `/api/bots` | GET | Bot catalog — manifests + live runtime + live personas + git + drift. `?refresh=1` bypasses cache |
| `/api/bots/index.md` | GET | Agent-readable fleet index; also rewrites `~/.claude/knowledge/bot-fleet.md` |
| `/api/bots/resolve?q=` | GET | Alias lookup — "diet bot" → the bot that serves it, with its live prompt |
| `/api/bots/personas` | GET | Live persona map plus personas no manifest claims |

## Bots catalog

A bot appears in the Bots tab when its repo has `.watchpost/bot.json` (see the
`bot-fleet` skill in `skills/bot-fleet/` for the schema). Repos outside the scanned
tree are added via `botManifestRoots` in `local/config.json`. Personas are read from
each bot's *running* config over SSH, so the catalog contradicts — and beats — any
stale description in a bot's own repo; those mismatches surface as drift.

## Formatting Rules
- **Task title rule:** MASTER_PLAN.md summary table titles MUST be max 80 chars. Put file lists, error details, and technical specifics in the `####` detailed section, not the table row. The Watchpost API rejects titles > 80 chars.
