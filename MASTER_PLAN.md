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
| TASK-004 | Hooks: Wire SessionStart/Stop hooks to POST heartbeat from sessions    | P1       | DONE     | TASK-003     |
| TASK-1771 | API: Daily-rotate heartbeats.jsonl into `data/heartbeats/YYYY-MM-DD.jsonl` | P2  | DONE     | TASK-003 |

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

**Priority:** P1 | **Status:** DONE (2026-04-27)

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

### TASK-1771: API: Daily-rotate heartbeats.jsonl into `data/heartbeats/YYYY-MM-DD.jsonl`

**Priority:** P2 | **Status:** DONE (2026-04-27)

**Depends on:** TASK-003

#### Problem

TASK-003 shipped a single unbounded `data/heartbeats.jsonl`. With TASK-004's SessionStart+Stop hooks now active and PostToolUse expansion possible, the file grows linearly with session count. Boot replay scans the whole file every time. Spec called this out under "Side effects to watch" but deferred to a follow-up.

#### Scope

- Write new heartbeats to `data/heartbeats/YYYY-MM-DD.jsonl` (UTC date, matching the changelog rotation pattern at `data/changelog/<project>/YYYY-MM-DD.jsonl`).
- Boot replay reads today's + yesterday's daily file plus the legacy `data/heartbeats.jsonl` (read-only) so existing entries don't disappear after upgrade.
- Replay still applies the 24h window filter — anything older is dropped on rebuild.
- Daily directory is created lazily on first flush.

#### Key files

- `controlroom/api.js` — replace `HEARTBEATS_FILE` write target with a date-keyed file under `HEARTBEATS_DIR`; expand `loadHeartbeatsFromDisk` to scan multiple sources.
- `.gitignore` — add `data/heartbeats/`.

#### Verification

- POST a heartbeat → file lands in `data/heartbeats/YYYY-MM-DD.jsonl` for today's UTC date.
- Pre-seed yesterday's file with a fresh entry → restart Watchpost → that sid replays into the in-memory map and surfaces in `/api/active-sessions`.
- Pre-seed `data/heartbeats.jsonl` (legacy) with a fresh entry → restart → that sid also replays.
- Pre-seed an old (>24h) entry → restart → that sid does NOT appear.

---

## Flow View Redesign

| ID        | Title                                                                  | Priority | Status  | Dependencies |
| --------- | ---------------------------------------------------------------------- | -------- | ------- | ------------ |
| TASK-1772 | Flow: make active-instances per-lane sequence the default Flow view    | P2       | DONE        | -            |

### TASK-1772: Flow: make active-instances per-lane sequence the default Flow view

**Priority:** P2 | **Status:** DONE (2026-05-09)

#### Goal

Make the delivery-lane / active-instances rendering (`renderDeliveryView()` in `flow/index.html`) the unconditional default for the Flow tab — including for projects whose MASTER_PLAN.md has no delivery lines, sprint framing, or derivable lines today. Currently the lane view is *already* the default for projects with lines (e.g. rough-cut), but Flow falls back to a dagre DAG ("streams" mode) when none parse.

#### Current state (verified by code map of `flow/index.html`)

- `init()` (line 4272) calls `fetchAndRender(true)` → `renderGraph()` (line 2275).
- `renderGraph()` lines 2280–2295 picks delivery vs streams:
  ```js
  const lines = deliveryLines.length > 0 ? deliveryLines
              : sprints.length > 0     ? buildLinesFromSprints(...)
              :                          buildDerivedDeliveryLines(tasks);
  if (lines.length > 0) { setViewMode('delivery'); renderDeliveryView(tasks, lines); return; }
  setViewMode('streams');   // dagre DAG fallback
  ```
- Lane renderers already exist:
  - `renderDeliveryView()` (lines ~2937–2980) — section frame + subtitle.
  - `renderCurrentFlowRow()` (lines ~2831–2882) — per-lane card chain with `blocked / in-progress / planned / upcoming` states.
  - `deriveLineStates()` (lines ~2674–2740) — classifies state and `isLiveInstance` from `activeLocks` + `activityEntries`.
- Streams toolbar (lines ~1560–1615) is hidden whenever mode ≠ 'streams' (line 3789), so promoting delivery to default automatically hides the DAG-only toolbar without further work.
- No view-toggle UI exists today — the choice is implicit in `renderGraph()`.

#### What "different from what we have" actually means

Comparing the screenshot (rough-cut, delivery view) to a project without delivery lines:
- Today: the screenshot view is rough-cut-only (it has explicit delivery lines in its MASTER_PLAN). Other projects render the dagre DAG by default.
- Goal: the lane / active-instances rendering is the universal landing view, with the DAG retained as an optional drilldown rather than the no-lines fallback.

#### Scope

- In `renderGraph()` (around line 2291), drop the `lines.length > 0` gate so `setViewMode('delivery')` + `renderDeliveryView(tasks, lines)` runs unconditionally; the existing `<div class="flow-empty">No active instances from current rough-cut logs or locks…</div>` branch (line ~2975) covers the empty case.
- Add a small toolbar toggle (Lanes / Graph) so the dagre view stays reachable. Place it in the toolbar block at lines 1560–1615 alongside the existing streams toggles, but make it visible regardless of `viewMode`. Default selection: Lanes.
- Audit `deriveLineStates()` to confirm its data sources (`activeLocks`, `activityEntries`) are wired to the same feeds as `/api/active-sessions` and `/api/dirty-attribution` (TASK-001/002/003), so liveness signals stay consistent across the dashboard. If they diverge, file a follow-up rather than rewiring inside this task.
- Do not delete `flow/index.html.bak-pre-fullseq-20260508-004931`; it stays as the rollback point for the pre-promotion layout.

#### Key files

- `flow/index.html` — `renderGraph()` line ~2280, toolbar lines 1560–1615, mode-visibility line 3789.
- `flow/index.html.bak-pre-fullseq-20260508-004931` — kept as historical reference (already untracked).
- `controlroom/api.js` — read-only audit only; no API changes expected for this task.

#### Verification

- Open the Flow tab against a project WITH delivery lines (rough-cut) → lane view renders identically to the current screenshot. No regression.
- Open the Flow tab against a project WITHOUT delivery lines (e.g. watchpost itself) → lane view's empty state renders instead of the DAG. Toolbar shows the new Lanes / Graph toggle.
- Click Graph in the toolbar → dagre view renders as before. Click Lanes → returns to the lane view.
- Each lane shows a chain with at least one BLOCKED/NEXT card and the `Continue` CTA jumps to the gating task's detail.
- Selecting any card in any lane opens the right detail pane with next-up score and depends-on chips populated from the same source as `/api/master-plan`.
- Lanes appear/disappear as rough-cut instances start/stop (verify against `/api/active-sessions`).
- Old layout is reachable via the secondary toggle and still renders without errors.

---

## Project Discovery

| ID        | Title                                                              | Priority | Status         | Dependencies |
| --------- | ------------------------------------------------------------------ | -------- | -------------- | ------------ |
| ~~TASK-1773~~ | ✅ Auto-discover projects from Claude Code session transcripts | P1       | ✅ DONE (2026-05-09) | -            |

### ~~TASK-1773~~: Auto-discover projects from Claude Code session transcripts (✅ DONE)

**Priority:** P1 | **Status:** ✅ DONE (2026-05-09)

#### Problem

Watchpost only learned about projects via two paths:
1. Bulk seed from `data/outlook.json` (`server.js:122-178`) — but `outlook.json` is written by an external producer that doesn't enumerate every project on disk. `rough-cut-mvp` (156KB MASTER_PLAN.md, active git repo, daily Claude sessions) was missing from its payload, so it stayed invisible.
2. On-demand `findProjectForCwd()` (`server.js:243-310`) — only fires when an API request arrives with `?cwd=…` inside the project. Projects never queried that way stayed invisible forever.

Net effect: a project with a real MASTER_PLAN.md and active Claude sessions could be invisible to `/api/projects`, `/api/master-plan`, the Flow view, and `/master-plan:next` until the user happened to make a Watchpost call from inside it.

#### Resolution

Added `discoverFromClaudeTranscripts()` to `server.js`:

- Walks every `.jsonl` file under `wpPaths.claudeProjectsDirs()` (respects `WATCHPOST_CLAUDE_PROJECTS_DIR` / `WATCHPOST_CLAUDE_PROJECTS_DIRS`).
- Reads only the first ~16KB of each transcript and extracts the first `cwd` field — bounded cost regardless of session length.
- For each unique cwd: registers it iff the cwd itself has `MASTER_PLAN.md` (root or `docs/`) or a `.watchpost.json` marker. **Deliberately skips cwds with only `.git`** to avoid false-positives like `~/` or scratch dirs.
- Idempotent: dedupes against existing roots/names; second invocation adds 0.
- Source per machine: transcripts are local, so no `mapPathToCurrentOS()` needed for the discovered cwd itself, but stored existing-project paths are still mapped before comparison.

Wiring:
- Runs once at server startup (gated `if (require.main === module)` so tests can require `server.js` without listening).
- New endpoints: `POST /api/discover/refresh`, `GET /api/discover/status`.
- `server.js` now exports `{ discoverFromClaudeTranscripts, getRegisteredProjects, findProjectForCwd }`.

#### Verification

- `tests/regression-discover-transcripts.js` — 8/8 pass: scans transcripts, extracts cwds, registers ≥1 project, persists with the right shape, rough-cut-mvp soft-check, idempotency.
- `tests/regression-projects-bootstrap.js` — 7/7 pass after relaxing the post-bootstrap "exactly empty" assertion (startup discovery now legitimately populates the file).
- Live restart: registry went 22 → 26 projects. Three new ones surfaced (`MAIN VULT`, `steady-stream`, `bina-ve-ze`) — all have a real `MASTER_PLAN.md` on disk.
- `POST /api/discover/refresh` returns `{ discovered: 0, scanned: 22539, transcriptCwds: 27 }` after warm-up — confirms idempotency under load.
- `GET /api/discover/status` exposes the new `bySource` breakdown: `{ manual: 3, auto-discovered: 20, transcript-discovered: 3 }`.

#### Files

- `server.js` — new function, two endpoints, gated startup, module.exports.
- `tests/regression-discover-transcripts.js` — new.
- `tests/regression-projects-bootstrap.js` — assertion relaxed to match new startup behavior.

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
