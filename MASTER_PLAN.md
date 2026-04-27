# Watchpost — MASTER_PLAN

Cross-project orchestration dashboard for tracking tasks, health, changelogs, and dependencies across all local projects.

**Source:** `~/.watchpost/` (own git repo, originally extracted from flow-state subtree).
**Server:** `controlroom/api.js` mounted on `localhost:6010` by `server.js`.
**Live data source:** `readLiveClaudeEntries()` scrapes Claude session JSONL transcripts from `~/.claude/projects/*/sessions/*.jsonl` — meaning manual editor edits are invisible to `/api/changelog`.

---

## Top Priority — Dirty-File Attribution & Session Liveness

These four tasks together close the "who's working on what right now?" gap in Watchpost. They were filed because cross-session cleanup workflows in `rough-cut` couldn't reliably distinguish manual user edits from agent edits, leading to one Claude session sweeping another session's WIP into commits.

### Active Tasks

| ID       | Title                                                                  | Priority | Status   | Dependencies |
| -------- | ---------------------------------------------------------------------- | -------- | -------- | ------------ |
| TASK-001 | API: Add `/api/dirty-attribution?cwd=` for git-vs-changelog join       | P0       | DONE     | -            |
| TASK-002 | API: Add `/api/active-sessions?cwd=` for sub-15min session liveness    | P0       | DONE     | -            |
| TASK-003 | API: Add `POST /api/sessions/heartbeat` + JSONL persistence            | P0       | DONE     | -            |
| TASK-004 | Hooks: Wire SessionStart/Stop hooks to POST heartbeat from sessions    | P1       | PLANNED  | TASK-003     |

---

## Active Work

### TASK-001: API: Add `/api/dirty-attribution?cwd=` for git-vs-changelog join

**Priority:** P0 | **Status:** DONE

#### Problem

Right now, attributing a dirty file in a worktree to "manual user edit vs agent edit vs shared in-flight" requires shelling out per file and joining against `/api/changelog` results in a Python script. The data Watchpost needs is already in memory via `getCombinedChangelogEntries()`; what's missing is one focused endpoint that performs the join.

#### Scope

- Run `git -C <cwd> status --porcelain` (with a 3s timeout via `child_process.execFile`) to enumerate dirty files for the requested cwd.
- For each file, query the existing in-memory changelog entries (last N days, default 1) filtered by `cwd` and `file`.
- Return per-file: `{file, sessions[{sid, lastSeenMs, edits, tasks[]}], lastClaudeEditMs, fileMtimeMs, verdict}` where `verdict` is one of `manual` (no agent hits in last 24h), `agent` (single agent owns it), or `shared` (multiple agents).
- Add a per-cwd cache with a short TTL (~2s) so polling clients don't re-spawn git unnecessarily.

#### Key files

- `~/.watchpost/controlroom/api.js` — add handler next to existing `/api/changelog` group (~line 1170).
- Reuse `getCombinedChangelogEntries`, `getProjectNameFromCwd` already defined in the same file.

#### Verification

- `curl -sG --data-urlencode "cwd=$(pwd)" http://localhost:6010/api/dirty-attribution | python3 -m json.tool` — returns array, each entry has `file`, `verdict`, `sessions`.
- Verdict matches the manual cross-check on a known-mixed worktree (rough-cut's current state is a good test).
- Response time < 200ms on a worktree with 20 dirty files (cache miss).

---

### TASK-002: API: Add `/api/active-sessions?cwd=` for sub-15min session liveness

**Priority:** P0 | **Status:** DONE

#### Problem

The `/next` skill currently infers "this task is being worked on right now by another session" from a heuristic over `/api/changelog` (weighted hits ≥ 3 in last 30min). That works but is noisy and re-implemented at every caller. Lift it into Watchpost.

#### Scope

- Walk in-memory changelog entries from `getCombinedChangelogEntries(0.5)` (last 30 min by default; query param `?minutes=N` overrides).
- Group by `sid`, optionally filter by `cwd` if the query param is provided.
- For each sid, compute: `{sid, agent, lastSeenMs, toolCalls, distinctFiles, taskTags[]}`.
- Optionally merge with the heartbeat layer from TASK-003 (so a session that hasn't made a tool call but is still alive shows up).

#### Key files

- `~/.watchpost/controlroom/api.js` — handler next to TASK-001's.

#### Verification

- `curl -sG --data-urlencode "cwd=$(pwd)" http://localhost:6010/api/active-sessions` returns the current live-session list.
- The rough-cut `/next` skill can replace its inline weighted-hits computation with this endpoint and produce identical actively-worked sets.

---

### TASK-003: API: Add `POST /api/sessions/heartbeat` + JSONL persistence

**Priority:** P0 | **Status:** DONE (2026-04-27)

#### Problem

Watchpost only knows a session is alive if it has emitted a tool call in the recent past. Sessions that are "warm but quiet" (waiting on user input, between tool calls, paused mid-investigation) look dead. A small heartbeat ping closes that gap and makes `/api/active-sessions` accurate.

#### Scope

- New `POST /api/sessions/heartbeat` accepting `{sid, cwd, activeTaskId?, agent?}`. Updates an in-memory map keyed by `sid` with `{cwd, activeTaskId, agent, lastSeenMs}`.
- Debounced flush to `~/.watchpost/data/heartbeats.jsonl` (one line per update) so a Watchpost restart doesn't blank-slate liveness. Rebuild map on boot from the last N hours of the JSONL.
- `/api/active-sessions` (TASK-002) reads from this map merged with the changelog-derived liveness.

#### Side effects to watch

- No auth; any localhost process can poison the heartbeat list. Mention in handler comment — Watchpost is local-only by design.
- JSONL grows unbounded; add a daily rotation hook similar to `data/changelog/<project>/YYYY-MM-DD.jsonl`.

#### Key files

- `~/.watchpost/controlroom/api.js` — handler + small in-memory store.
- `~/.watchpost/data/heartbeats.jsonl` — new persistence path.

#### Verification

- `curl -X POST -H 'Content-Type: application/json' -d '{"sid":"abc","cwd":"/tmp"}' http://localhost:6010/api/sessions/heartbeat` returns 200.
- `/api/active-sessions` reflects the new sid within 1s.
- Restarting Watchpost rebuilds the map from disk; sub-15min heartbeats remain.

---

### TASK-004: Hooks: Wire SessionStart/Stop hooks to POST heartbeat from sessions

**Priority:** P1 | **Status:** PLANNED

**Depends on:** TASK-003

#### Problem

The heartbeat endpoint is useless without sessions actually pinging it. Wire `SessionStart` and `Stop` (and optionally a throttled `PostToolUse`) hooks in `~/.claude/settings.json` so every Claude Code session calls in.

#### Scope

- Add hooks via the `update-config` skill (do not hand-edit settings.json):
  - `SessionStart`: `curl -m 1 -s -X POST -H 'Content-Type: application/json' -d "{\"sid\":\"$CLAUDE_SESSION_ID\",\"cwd\":\"$PWD\"}" http://localhost:6010/api/sessions/heartbeat || true`
  - `Stop`: same payload (final liveness ping before exit).
- `-m 1` (1s timeout) and `|| true` (so a Watchpost outage never breaks session startup or exit).
- Optional: `PostToolUse` throttled to ≥ 60s between calls so long sessions stay marked alive without spamming the endpoint.

#### Key files

- `~/.claude/settings.json` — patched via `update-config` skill.

#### Verification

- Start a fresh Claude Code session in any project.
- `curl -sG --data-urlencode "minutes=2" http://localhost:6010/api/active-sessions` shows the new sid within seconds.
- Killing Watchpost mid-session does not cause the hook to error out (runs `|| true`).

---

## Migrated Historical Tasks From FlowState

These entries were moved from `flow-state/docs/MASTER_PLAN.md` so Watchpost work is tracked in the Watchpost repo. Source IDs and completion statuses are preserved.

| ID             | Title                                                        | Priority | Status  |
| -------------- | ------------------------------------------------------------ | -------- | ------- |
| ~~TASK-1770~~  | Watchpost VPS Server monitoring panel                        | P2       | DONE    |
| ~~TASK-1755~~  | Watchpost Control Room UI redesign + smart project switcher  | P2       | DONE    |
| ~~TASK-1751~~  | AI cover generation improvements + cover gallery            | P3       | DONE    |
| ~~TASK-1754~~  | Drag-to-reorder projects in Control Room                     | P3       | DONE    |
| ~~TASK-1745~~  | Restore BUG-1716 parser fix — #### headers + column-order    | P1       | DONE    |
| ~~TASK-1746~~  | Add Changelog/Logs tab to Watchpost dashboard                | P2       | DONE    |
| ~~TASK-1747~~  | Watchpost cover art API integration                          | P3       | DONE    |
| ~~TASK-1748~~  | Watchpost project detail panel — summary + cover upload      | P2       | DONE    |
| ~~TASK-1749~~  | Mark TASK-303 orchestrator section as archived               | P3       | DONE    |
| ~~TASK-1752~~  | Control Room activity views + combinable filters             | P2       | DONE    |
| ~~TASK-1750~~  | Create favicon for Watchpost dashboard                       | P3       | DONE    |
| ~~TASK-1483~~  | Redesign Watchpost Dashboard UI                              | P2       | DONE    |
| ~~BUG-1716~~   | Watchpost parser shows priority as workspace task title      | P1       | DONE    |
| ~~BUG-1113~~   | Stale worktrees not cleaned up                               | P0       | DONE    |
| TASK-1462      | Watchpost TUI — Multi-Project Support                        | P2       | PLANNED |

### ~~TASK-1770~~: Watchpost VPS Server monitoring panel

**Priority:** P2 | **Status:** DONE (2026-04-17)

#### Goal

Add a "Server" tab to Watchpost with live monitoring of all VPS services and infrastructure.

#### Completed scope

- New `vps/` panel with Services + Health sub-tabs.
- Live Docker auto-discovery so running containers appear automatically on each poll.
- `vps/bots.json` enrichment registry with names, covers, dashboard links, restart commands, and category grouping.
- SSH via stdin piping with ControlMaster reuse.
- HTTP pings for reachability.
- Health sub-tab with CPU sparkline, RAM/disk bars, load average, uptime, top processes, and network I/O.
- Cover sharing from VPS services to local project covers via `projectAlias`.
- DNS and Caddy proxy setup for `botson.noamnau.com` and `waha.noamnau.com`.

#### Files

- `watchpost/vps/api.js`
- `watchpost/vps/index.html`
- `watchpost/vps/bots.json`
- `watchpost/server.js`
- `watchpost/index.html`

---

### ~~TASK-1755~~: Watchpost Control Room UI redesign + smart project switcher

**Priority:** P2 | **Status:** DONE (2026-04-09)

#### Goal

Redesign the Control Room and main dashboard project switching UX. Replace the flat native dropdown with a command palette, add a hero card for the active project, editorial card covers with overlaid names, decluttered topbar, status-aware card borders, Spotlight pattern, masterPlan-filtered switcher, and Browse All Projects modal with card grid.

#### Files

- `watchpost/controlroom/index.html`
- `watchpost/controlroom/api.js`
- `~/.watchpost/index.html`
- `~/.watchpost/local/views/controlroom/index.html`

---

### ~~TASK-1751~~: AI cover generation improvements + cover gallery

**Priority:** P3 | **Status:** DONE (2026-04-10)

#### Note

The source FlowState plan used duplicate `TASK-1755` IDs for this and the Control Room redesign. Assigned `TASK-1751` here so the migrated task keeps a valid unique task ID.

#### Completed scope

- Refined cover prompt to minimize unwanted AI text.
- Cover containers use 4:3 aspect-ratio instead of fixed height.
- Cover history versioning saves old covers before overwrite.
- Cover gallery modal supports browsing and restoring past covers.
- Generation debounce prevents duplicate API calls.
- Fixed event listener accumulation bug in the detail panel.

---

### ~~TASK-1754~~: Drag-to-reorder projects in Control Room

**Priority:** P3 | **Status:** DONE (2026-04-05)

#### Goal

Let users drag project cards to set a custom display order in the Control Room Projects tab. Persist order in `~/.watchpost/projects.json`, falling back to Last Active sorting when no custom order is set.

#### Files

- `~/.watchpost/local/views/controlroom/index.html`
- `~/.watchpost/server.js`

---

### ~~TASK-1745~~: Restore BUG-1716 parser fix — #### headers + column-order

**Priority:** P1 | **Status:** DONE (2026-04-04)

#### Problem

BUG-1716 fix was marked DONE but lost when Watchpost files reverted to pre-edit state. Needed to re-apply parser fixes.

#### Restored scope

- `kanban/index.html` parser matches `####` headers, not just `###`.
- `~/.watchpost/modules/task-engine.js` supports tables with `ID|Priority|Description` order.
- Robust priority extraction in both parsers.

#### Files

- `watchpost/kanban/index.html`
- `~/.watchpost/modules/task-engine.js`

---

### ~~TASK-1746~~: Add Changelog/Logs tab to Watchpost dashboard

**Priority:** P2 | **Status:** DONE (2026-04-05)

#### Problem

A changelog capture system existed and was actively logging, but the dashboard tab to view those logs was missing. Data was intact under `~/.watchpost/data/changelog/`.

#### Goal

Add a "Logs" tab that renders changelog data in a searchable, per-project timeline view showing what each AI session did.

#### Files

- `watchpost/index.html`
- `watchpost/logs/index.html`

---

### ~~TASK-1747~~: Watchpost cover art API integration

**Priority:** P3 | **Status:** DONE (2026-04-05)

#### Problem

Control Room had placeholder gradients for project covers. Backend supported pluggable image generation through `POST /api/projects/:name/generate-cover`, but no provider was configured.

#### Goal

Configure and test at least one image generation API for auto-generating project cover art from the dashboard.

#### Files

- `watchpost/controlroom/api.js`
- `~/.watchpost/settings.json`

---

### ~~TASK-1748~~: Watchpost project detail panel — summary + cover upload

**Priority:** P2 | **Status:** DONE (2026-04-05)

#### Problem

The Control Room detail slide-in panel had project info, but the 7-day summary and cover upload/change flow needed testing and polish.

#### Goal

Wire the detail panel summary to `/api/projects/:name/summary`, test cover upload, and ensure notes save correctly.

#### Files

- `watchpost/controlroom/index.html`

---

### ~~TASK-1749~~: Mark TASK-303 orchestrator section as archived in MASTER_PLAN

**Priority:** P3 | **Status:** DONE (2026-04-05)

#### Problem

TASK-303 Watchpost Orchestrator still showed as paused with pending subtasks after the orchestrator was intentionally removed.

#### Goal

Archive TASK-303, update status to ARCHIVED, and evaluate remaining subtasks such as BUG-1019 OOM prevention independently.

#### Result

Orchestrator was archived as removed and superseded by Claude Code's built-in agent tooling and oh-my-claudecode multi-agent orchestration.

---

### ~~TASK-1752~~: Control Room — Activity-based project views + combinable filters

**Priority:** P2 | **Status:** DONE (2026-04-05)

#### Problem

Control Room only grouped by folder category.

#### Goal

Add a Group By dropdown for Category, Activity Level, Task Status, or None, working alongside existing sort controls. Category chips update to match the selected grouping.

#### Files

- `watchpost/controlroom/index.html`

---

### ~~TASK-1750~~: Create favicon for Watchpost dashboard

**Priority:** P3 | **Status:** DONE (2026-04-05)

#### Problem

Watchpost dashboard at `localhost:6010` had no favicon.

#### Goal

Create a recognizable favicon matching the Watchpost brand.

#### Files

- `watchpost/favicon.ico`
- `watchpost/index.html`

---

### ~~TASK-1483~~: Redesign Watchpost Dashboard UI

**Priority:** P2 | **Status:** DONE (2026-04-04)

#### Implemented

Control Room landing page with project grid/list, category grouping, filter chips, sort dropdown, kickstart prompts, copy-path, notes section, archive/delete. Orchestrator removed from `server.js`, `kanban`, and `index.html`.

---

### ~~BUG-1716~~: Watchpost parser shows "P1" as title for workspace tasks

**Priority:** P1 | **Status:** DONE (2026-03-24)

#### Problem

Workspace tasks showed priority as the title in Watchpost kanban. Root causes were parsers matching only `###` headers and assuming `ID|Title|Priority` table order.

#### Fix

Updated Watchpost parsers for `####` header support, column-order detection, and robust priority extraction. Added detail sections for workspace tasks in the source plan.

---

### ~~BUG-1113~~: Stale Worktrees Not Cleaned Up - Forces Claude Code Context Bloat

**Priority:** P0 | **Status:** DONE (2026-02-22) | **Parent:** TASK-303

#### Problem

The Watchpost orchestrator created git worktrees in `.agent-worktrees/` for each task but did not clean them up after completion, wasting context and disk space.

#### Expected behavior

- Clean up worktrees after task completion.
- Automatically clean worktrees older than 24 hours.
- Provide a manual cleanup command in the UI.

#### Status note

Likely resolved or superseded by orchestrator removal.

#### Files

- `~/.watchpost/server.js`

---

### TASK-1462: Watchpost TUI — Multi-Project Support

**Priority:** P2 | **Status:** PLANNED

#### Problem

`watchpost tui` currently only works with FlowState. Running from another project directory shows 0 tasks.

#### Goal

Make `watchpost tui` work with any project that has a `MASTER_PLAN.md` by parsing it directly.

#### Approach

- Verify `~/.local/bin/watchpost` wrapper propagates `WATCHPOST_CWD` after restart.
- Parse tasks directly from `MASTER_PLAN.md` headers.
- Map `MASTER_PLAN.md` statuses to TUI columns.
- Dead beads code removal was completed via TASK-1480.

#### Files

- `~/.watchpost/tui/src/lib/bd-client.js`
- `~/.watchpost/tui/src/lib/masterplan-parser.js`
- `~/.watchpost/tui/src/hooks/use-board-data.js`

---

## Foundation (DONE / Pre-existing)

| ID           | Title                                              | Priority | Status |
| ------------ | -------------------------------------------------- | -------- | ------ |
| ~~TASK-000~~ | Initial import from flow-state subtree             | P0       | DONE   |
