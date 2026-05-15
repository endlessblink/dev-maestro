# Control Room — Watchpost Feature Plan

## Overview

Add a **Control Room** as the new landing page for Watchpost. It shows all registered projects as a visual grid/list, each with cover art, quick stats, and the ability to open a terminal or view project details. Includes a personal tasks/notes section and project archive/delete management.

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Landing page | Control Room replaces Kanban as default | User preference — Kanban becomes per-project |
| Layout | Card grid + compact list with toggle | Both views, user switches freely |
| Terminal launch | Configurable (Warp / Konsole / Kitty) | Multiple terminals installed, user picks in settings |
| Cover art API | Pluggable adapter pattern | User wants specific APIs (ideogram, etc.) — design as swappable |
| Summary generation | Git log + MASTER_PLAN.md → LLM | Last 7 days, non-technical language |
| Data storage | Extend `projects.json` + new `~/.watchpost/data/covers/` | Covers cached as files, metadata in projects.json |

---

## Phase 1: Control Room Foundation (Backend + Data)

### 1.1 — Extend project data model
**File:** `server.js` (new routes)

- `GET /api/projects/enriched` — returns all projects with:
  - Task counts by status (parsed from each project's MASTER_PLAN.md)
  - Cover image path (if exists)
  - Last activity date (from git log)
  - Archive status
- Add fields to `projects.json` entries:
  - `coverImage: string | null` — path to cover in `~/.watchpost/data/covers/`
  - `archived: boolean` — default false
  - `notes: string` — personal notes
  - `terminalPreference: string` — override per-project (optional)

### 1.2 — Project stats endpoint
**File:** `server.js` (new route)

- `GET /api/projects/:name/stats` — for a single project:
  - Parse MASTER_PLAN.md → count tasks by status (DONE, IN PROGRESS, PLANNED, etc.)
  - Parse git log (last 7 days) → commit count, files changed
  - Return structured JSON

### 1.3 — Project summary endpoint
**File:** `server.js` (new route)

- `GET /api/projects/:name/summary` — returns 7-day non-technical summary
  - Reads git log + MASTER_PLAN.md
  - Formats as structured data (commits grouped by type, completed tasks listed)
  - LLM summarization is **optional/future** — start with a template-based summary:
    - "This week: completed X tasks, Y commits. Key changes: [list of DONE task titles]"
  - Cache result for 1 hour in `~/.watchpost/data/summaries/`

### 1.4 — Kickstart prompt generation endpoint
**File:** `server.js` (new route)

- `GET /api/projects/:name/kickstart` — generates a session kickstart prompt
  - Gathers and formats:
    - **Project context:** name, tech stack (from package.json/Cargo.toml), brief description
    - **Recent activity:** last 7 days git log summarized (X commits, key changes)
    - **Next recommended task:** highest-priority non-done task from MASTER_PLAN.md
    - **Open bugs/blockers:** any BUG-XXX items that are IN PROGRESS or PLANNED
  - Returns `{ path: "/absolute/project/path", cdCommand: "cd /path", prompt: "..." }`
  - Prompt is formatted as a natural-language briefing, ready to paste into Claude Code
  - Cache for 30 min in `~/.watchpost/data/summaries/`

### 1.5 — Project archive/delete endpoints
**File:** `server.js` (new routes)

- `POST /api/projects/:name/archive` — sets `archived: true` in projects.json
- `POST /api/projects/:name/unarchive` — sets `archived: false`
- `DELETE /api/projects/:name` — removes from projects.json (does NOT delete files on disk)

### 1.6 — Personal notes/tasks endpoint
**File:** `server.js` (new routes), new file `~/.watchpost/data/user-notes.json`

- `GET /api/notes` — returns all personal notes/tasks
- `POST /api/notes` — add a note `{ text, type: 'task'|'note', done: false }`
- `PATCH /api/notes/:id` — update (toggle done, edit text)
- `DELETE /api/notes/:id` — remove

---

## Phase 2: Cover Art System

### 2.1 — Cover image storage
**Directory:** `~/.watchpost/data/covers/`

- Covers stored as `{project-name}.png` (or .jpg/.webp)
- `GET /api/projects/:name/cover` — serves the cover image (or 404)

### 2.2 — Manual cover upload
- `POST /api/projects/:name/cover` — accepts multipart image upload
- Saves to `~/.watchpost/data/covers/{name}.png`
- Updates `projects.json` entry

### 2.3 — AI cover generation (pluggable)
**New file:** `server.js` or `scripts/generate-cover.js`

- `POST /api/projects/:name/generate-cover`
  - Body: `{ prompt?: string }` — optional custom prompt, default auto-generates from project name + description
  - Adapter pattern for API provider:
    - Config in `~/.watchpost/settings.json`: `{ "coverApi": { "provider": "ideogram", "apiKey": "..." } }`
    - Each adapter: takes prompt → returns image buffer
  - Saves result to covers directory
  - **Supported providers** (implemented as simple fetch wrappers):
    - `ideogram` — POST to ideogram.ai API
    - `fal` — POST to fal.ai API (for models like nano-banana-pro, flux, etc.)
    - `openai` — POST to DALL-E API
    - `manual` — no generation, upload only
  - User provides API key + endpoint details in settings — we just relay the request

---

## Phase 3: Control Room Frontend

### 3.1 — Control Room HTML page
**New file:** `controlroom/index.html`

- Pure HTML/CSS/JS (matches existing Watchpost stack — no build tools)
- Matches existing design tokens (pure black theme, teal accent)
- Sections:
  1. **Header bar** — search/filter, grid/list toggle, "Show archived" toggle
  2. **Project grid/list** — all active projects
  3. **Personal notes/tasks** — collapsible sidebar or bottom section
  4. **Archived projects** — hidden by default, shown via toggle

### 3.2 — Project card component
Each card shows:
- **Cover image** (or gradient placeholder with project initial if no cover)
- **Project name**
- **Quick stats bar** — colored dots/badges: X done, Y in progress, Z planned
- **Last activity** — "2 days ago" relative time
- **Action buttons:**
  - **Copy path** (clipboard icon) — copies `cd /project/path` to clipboard, shows toast "Copied!"
  - **Copy kickstart prompt** (rocket icon) — calls `/api/projects/:name/kickstart`, copies generated prompt to clipboard
  - View details (expand/arrow icon)
  - Context menu (three dots): archive, delete, change cover

### 3.3 — Compact list view
Same data as cards but in a dense table/list:
- `[cover thumb] | Name | Done/InProgress/Planned | Last Activity | [Open] [Details]`

### 3.4 — Project detail panel
Clicking a card opens a detail view (slide-in panel or new page):
- Large cover image
- Project name + path
- **7-day summary** (auto-generated, non-technical)
- **Task breakdown** — donut chart or stacked bar (done/progress/planned)
- **Recent activity** — last 10 commits in human-readable form
- **Notes** — per-project notes field
- **Actions** — Copy path, Copy kickstart prompt, Archive, Delete, Regenerate cover

### 3.5 — Personal notes/tasks section
- Simple checklist UI at the bottom or in a sidebar
- Add new note/task inline
- Toggle done
- Filter: all / active / completed
- Persisted via `/api/notes` endpoints

### 3.6 — Settings panel
Small settings popover/modal:
- **Cover API provider:** dropdown + API key input + endpoint URL
- **Kickstart prompt template:** editable template for what the prompt includes
- **Theme:** (future, for now just the existing dark theme)

---

## Phase 4: Integration

### 4.1 — Update index.html to make Control Room the landing page
**File:** `index.html`

- Add Control Room as first tab (or make it the default view before tabs)
- When clicking a project in Control Room → switch to Kanban tab filtered to that project
- Or: Control Room is a "home" page, tabs are per-project after you click in

### 4.2 — Update server.js routing
- Mount all new routes
- Serve `controlroom/` static directory
- Ensure CORS and existing routes still work

### 4.3 — Project discovery refresh
- Add button to re-scan for new projects (triggers existing auto-discovery)
- Show "X new projects found" notification

---

## File Changes Summary

| Action | File/Directory |
|--------|---------------|
| **New** | `controlroom/index.html` — full Control Room UI |
| **New** | `~/.watchpost/data/covers/` — cover image storage |
| **New** | `~/.watchpost/data/summaries/` — cached summaries |
| **New** | `~/.watchpost/data/user-notes.json` — personal notes |
| **New** | `~/.watchpost/settings.json` — user preferences (terminal, cover API) |
| **Modify** | `server.js` — add all new API routes |
| **Modify** | `index.html` — add Control Room as landing/tab |
| **Modify** | `~/.watchpost/projects.json` — extend schema with coverImage, archived, notes |

---

## Implementation Order

1. **Phase 1** (backend) — all API routes, data model extensions
2. **Phase 3.1-3.3** (frontend) — basic grid/list with placeholder covers
3. **Phase 1.4** (terminal) — terminal launch working
4. **Phase 3.4** (detail panel) — project detail view with summary
5. **Phase 3.5** (notes) — personal tasks/notes
6. **Phase 2** (covers) — manual upload first, then AI generation
7. **Phase 4** (integration) — wire into main index.html, settings

---

## Open Questions (deferred to implementation)

- **LLM for summaries:** Use local Ollama or cloud API? Start with template-based, upgrade later
- **Cover API specifics:** User will provide API keys/endpoints at setup time — the adapter pattern supports adding any REST image API
- **Terminal integration:** Replaced with copy-to-clipboard approach (path + kickstart prompt) — works with any terminal, no API dependency
