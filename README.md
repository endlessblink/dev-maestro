# Dev Maestro

AI agent orchestration platform with Kanban board, Health scanning, Skills visualization, multi-agent workflows, and Beads integration.

## Installation (Standalone)

Install Dev Maestro on any system with one command:

```bash
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash
```

This installs to `~/.dev-maestro/`. To customize the location:

```bash
export DEV_MAESTRO_DIR=/path/to/install
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash
```

## Updating

Run the same install command to update to the latest version:

```bash
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash
```

Or manually:

```bash
cd ~/.dev-maestro
git pull origin main
npm install
```

## Starting the Server

```bash
cd ~/.dev-maestro
npm start
# Open http://localhost:6010
```

Or with install + start:

```bash
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash -s -- --start
```

## Configuration

Create a `.env` file from the example:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `6010` | Server port |
| `MASTER_PLAN_PATH` | `../docs/MASTER_PLAN.md` | Path to your MASTER_PLAN.md file |

**Using with any project:**

```bash
# In your .env file:
MASTER_PLAN_PATH=/path/to/your/project/docs/MASTER_PLAN.md
```

## Dashboard Views

| Tab | Description |
|-----|-------------|
| **Kanban** | Development task tracking parsed from MASTER_PLAN.md |
| **Health** | Code quality scanning (TypeScript, ESLint, Knip, npm audit) |
| **Skills** | Claude Code skills with analytics and dependency graph |
| **Docs** | Interactive documentation canvas with search |
| **Timeline** | Development timeline with locks and dependencies |
| **Stats** | Project metrics and statistics |
| **Orchestrator** | Multi-agent workflow UI |
| **Beads** | Task execution with git worktree isolation |

## Features

- **Multi-phase agent orchestration** - Requirements → Questions → Planning → Execution → Review
- **Beads integration** - Git worktree-based task execution with isolated branches
- **5 supervisor templates** - Worker, Backend, Frontend, DevOps, QA
- **40+ REST endpoints** + 4 SSE channels for real-time updates
- **Live sync** - Changes to MASTER_PLAN.md auto-refresh the UI
- **Drag-and-drop** task status updates
- **Health scanning** with 8+ code quality metrics
- **Dark theme** optimized for developers

## Shell Alias (Optional)

Add to `~/.bashrc` or `~/.zshrc`:

```bash
alias dev-maestro='cd ~/.dev-maestro && node server.js'
```

Then just run `dev-maestro` from anywhere.
