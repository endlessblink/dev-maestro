'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Paths ───────────────────────────────────────────────────────────────────

const WATCHPOST_DIR = path.join(process.env.HOME, '.watchpost');
const PROJECTS_FILE = path.join(WATCHPOST_DIR, 'projects.json');
const DATA_DIR = path.join(WATCHPOST_DIR, 'data');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const SUMMARIES_DIR = path.join(DATA_DIR, 'summaries');
const NOTES_FILE = path.join(DATA_DIR, 'user-notes.json');
const SETTINGS_FILE = path.join(WATCHPOST_DIR, 'settings.json');
const CHANGELOG_DIR = path.join(DATA_DIR, 'changelog');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJSON(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Parse task status counts from a MASTER_PLAN.md file.
 *
 * Supports two task-header conventions and dedupes by task ID so a task
 * appearing in both a summary table AND a `###` detail section is counted once.
 *
 *   1. Emoji `###` headers (flow-state style):
 *        ### TASK-123: Title (📋 PLANNED)
 *        ### ~~TASK-042~~: Title (✅ **DONE**)
 *
 *   2. Pipe-delimited summary tables (rough-cut style):
 *        | TASK-079 | ... | P1 | PLANNED | ... |
 *        | ~~TASK-072~~ | ... | P2 | ✅ **DONE** (2026-03-30) | ... |
 *
 * Header-derived status wins over table-derived status when both exist
 * (headers are typically updated more carefully). "TODO" is treated as
 * PLANNED. Strikethrough around an ID forces DONE.
 *
 * Returns { done, inProgress, planned, paused, review, total }.
 */
function parseTaskStats(masterPlanPath) {
    const stats = { done: 0, inProgress: 0, planned: 0, paused: 0, review: 0, total: 0 };
    try {
        const content = fs.readFileSync(masterPlanPath, 'utf8');
        // T must come LAST in alternation so longer prefixes (TASK, etc.) win
        // left-to-right matching first. See flow/index.html ID_PATTERN comment.
        const ID_RE = /(TASK|BUG|ROAD|IDEA|ISSUE|FEATURE|INQUIRY|T)-\d+/i;
        const STRIKE_RE = /~~\s*(TASK|BUG|ROAD|IDEA|ISSUE|FEATURE|INQUIRY|T)-\d+\s*~~/i;
        const TABLE_SEPARATOR_RE = /^\s*\|\s*:?-{2,}/;

        function classify(text) {
            const t = text.replace(/\*\*/g, '');
            // Emoji + word (most specific)
            if (/✅\s*DONE/i.test(t)) return 'done';
            if (/🔄\s*IN\s*PROGRESS/i.test(t)) return 'inProgress';
            if (/📋\s*PLANNED/i.test(t)) return 'planned';
            if (/⏸️?\s*PAUSED/i.test(t)) return 'paused';
            if (/👀\s*REVIEW/i.test(t)) return 'review';
            // Strikethrough on the task ID itself implies done
            if (STRIKE_RE.test(t)) return 'done';
            // Plain status words (word-boundary) for summary tables
            if (/\bDONE\b/i.test(t)) return 'done';
            if (/\bIN\s+PROGRESS\b/i.test(t)) return 'inProgress';
            if (/\bPAUSED\b/i.test(t)) return 'paused';
            if (/\bREVIEW\b/i.test(t)) return 'review';
            if (/\b(?:PLANNED|TODO)\b/i.test(t)) return 'planned';
            return null;
        }

        // id (upper-cased) -> status. Dedup across tables and headers.
        const byId = new Map();

        // 1. Pipe-delimited summary-table rows
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('|')) continue;
            if (TABLE_SEPARATOR_RE.test(line)) continue;
            const idMatch = line.match(ID_RE);
            if (!idMatch) continue;
            const status = classify(line);
            if (status) byId.set(idMatch[0].toUpperCase(), status);
        }

        // 2. `###` headers — overwrite table-derived status (more authoritative)
        const headerLines = content.match(/^###\s.+$/gm) || [];
        for (const h of headerLines) {
            const idMatch = h.match(ID_RE);
            if (!idMatch) continue;
            const status = classify(h);
            if (status) byId.set(idMatch[0].toUpperCase(), status);
        }

        for (const status of byId.values()) {
            if (status in stats) stats[status] += 1;
        }
        stats.total = stats.done + stats.inProgress + stats.planned + stats.paused + stats.review;
    } catch {
        // File unreadable or absent — return zeroed stats
    }
    return stats;
}

/**
 * Gather git information for a project root.
 * Returns { lastCommitDate, commits7d, recentCommits }
 */
function getGitInfo(projectRoot) {
    const info = { lastCommitDate: null, commits7d: 0, recentCommits: [] };
    try {
        info.lastCommitDate = execSync('git log -1 --format=%ci', {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: 'pipe'
        }).trim() || null;
    } catch { /* not a git repo or no commits */ }

    try {
        const raw = execSync('git log --since="7 days ago" --oneline --no-merges', {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: 'pipe'
        }).trim();
        const lines = raw ? raw.split('\n').filter(Boolean) : [];
        info.commits7d = lines.length;
        info.recentCommits = lines.slice(0, 20).map(line => {
            const [hash, ...rest] = line.split(' ');
            return { hash, message: rest.join(' ') };
        });
    } catch { /* ok */ }

    return info;
}

/**
 * Detect the primary tech stack for a project root.
 * Returns a human-readable string, e.g. "Vue 3, TypeScript, Vite"
 */
function detectTechStack(projectRoot) {
    // 1. package.json → look for known frameworks
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
        const allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
        const parts = [];

        if (allDeps['vue']) parts.push('Vue ' + (allDeps['vue'].replace(/[^0-9.]/g, '').split('.')[0] || '3'));
        else if (allDeps['react']) parts.push('React');
        else if (allDeps['svelte']) parts.push('Svelte');
        else if (allDeps['@angular/core']) parts.push('Angular');

        if (allDeps['typescript'] || allDeps['ts-node']) parts.push('TypeScript');
        if (allDeps['vite']) parts.push('Vite');
        else if (allDeps['webpack']) parts.push('Webpack');

        if (allDeps['electron']) parts.push('Electron');
        if (allDeps['@tauri-apps/cli'] || allDeps['@tauri-apps/api']) parts.push('Tauri');

        if (parts.length > 0) return parts.join(', ');
        return 'Node.js';
    } catch { /* no package.json */ }

    // 2. Cargo.toml → Rust
    if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) return 'Rust';

    // 3. pyproject.toml / setup.py → Python
    if (
        fs.existsSync(path.join(projectRoot, 'pyproject.toml')) ||
        fs.existsSync(path.join(projectRoot, 'setup.py'))
    ) return 'Python';

    // 4. go.mod → Go
    if (fs.existsSync(path.join(projectRoot, 'go.mod'))) return 'Go';

    return 'Unknown';
}

/**
 * Find a project by name from projects.json. Returns null if not found.
 */
function findProject(name) {
    const data = readJSON(PROJECTS_FILE, { projects: [] });
    const projects = Array.isArray(data) ? data : (data.projects || []);
    return projects.find(p => p.name === name) || null;
}

/**
 * Load all projects array from projects.json.
 */
function loadProjects() {
    const data = readJSON(PROJECTS_FILE, { projects: [] });
    return Array.isArray(data) ? data : (data.projects || []);
}

/**
 * Persist the projects array back to projects.json.
 */
function saveProjects(projects) {
    const data = readJSON(PROJECTS_FILE, { projects: [] });
    if (Array.isArray(data)) {
        writeJSON(PROJECTS_FILE, projects);
    } else {
        data.projects = projects;
        writeJSON(PROJECTS_FILE, data);
    }
}

/**
 * Resolve a cover file path for a project name.
 * Returns the full path if found, or null.
 */
function findCoverFile(name) {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const candidate = path.join(COVERS_DIR, `${name}.${ext}`);
        if (fs.existsSync(candidate)) return { filePath: candidate, ext };
    }
    return null;
}

// ─── Route mount ─────────────────────────────────────────────────────────────

module.exports = function mountControlRoomRoutes(app) {

    // Ensure data directories exist at startup
    fs.mkdirSync(COVERS_DIR, { recursive: true });
    fs.mkdirSync(SUMMARIES_DIR, { recursive: true });

    // ── 1. GET /api/projects/enriched ──────────────────────────────────────

    app.get('/api/projects/enriched', (req, res) => {
        const projects = loadProjects();
        const enriched = projects.map(project => {
            const taskStats = parseTaskStats(project.masterPlan || '');
            const cover = findCoverFile(project.name);
            const gitInfo = getGitInfo(project.root || '');

            return {
                ...project,
                taskStats,
                coverUrl: cover ? `/api/projects/${encodeURIComponent(project.name)}/cover` : null,
                lastActivity: gitInfo.lastCommitDate,
                commits7d: gitInfo.commits7d,
                archived: project.archived || false
            };
        });

        res.json(enriched);
    });

    // ── 1b. GET /api/outlook — cross-project digest for Claude sessions ────
    //
    // Returns an aggregated snapshot of every registered project (task stats,
    // git activity, top in-progress titles). Designed to be injected as
    // session context via a SessionStart hook so every Claude Code instance
    // starts with a wide outlook across all projects.
    //
    // Query params:
    //   ?format=markdown  → condensed markdown digest (default: json)
    //   ?includeStale=1   → include projects with zero activity in 30 days

    const OUTLOOK_CACHE_FILE = path.join(DATA_DIR, 'outlook.json');
    const OUTLOOK_TTL_MS = 5 * 60 * 1000; // 5 minutes

    function extractInProgressTitles(masterPlanPath, limit = 2) {
        const titles = [];
        const seen = new Set();
        const ID_FULL_RE = /(TASK|BUG|ROAD|IDEA|ISSUE|FEATURE|INQUIRY)-\d+/i;
        const truncate = (s) => s.length > 60 ? s.slice(0, 57) + '…' : s;

        try {
            const content = fs.readFileSync(masterPlanPath, 'utf8');

            // 1. `###` headers (emoji-status style)
            const headers = content.match(/^###\s.+$/gm) || [];
            for (const h of headers) {
                if (titles.length >= limit) break;
                if (!/🔄\s*(?:\*\*)?IN\s*PROGRESS/i.test(h)) continue;
                const m = h.match(/###\s+~?~?(TASK|BUG|ROAD|IDEA|ISSUE|FEATURE|INQUIRY)-\d+~?~?\s*[:\-–]\s*([^()]+?)\s*\(/i);
                if (!m) continue;
                const idRaw = m[0].match(ID_FULL_RE);
                const id = idRaw ? idRaw[0].toUpperCase() : '';
                if (id && seen.has(id)) continue;
                let title = m[2].replace(/~~|\*\*/g, '').trim();
                title = truncate(title);
                titles.push(id ? `${id}: ${title}` : title);
                if (id) seen.add(id);
            }

            // 2. Summary-table rows (plain-word status style)
            if (titles.length < limit) {
                const TABLE_SEP_RE = /^\s*\|\s*:?-{2,}/;
                for (const line of content.split('\n')) {
                    if (titles.length >= limit) break;
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('|')) continue;
                    if (TABLE_SEP_RE.test(line)) continue;
                    // Require a plain-word "IN PROGRESS" status (emoji variant handled above)
                    if (!/\bIN\s+PROGRESS\b/i.test(line.replace(/\*\*/g,''))) continue;
                    const cells = line.split('|').map(c => c.trim()).filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''));
                    if (cells.length < 2) continue;
                    const idMatch = cells[0].match(ID_FULL_RE);
                    if (!idMatch) continue;
                    const id = idMatch[0].toUpperCase();
                    if (seen.has(id)) continue;
                    let title = (cells[1] || '').replace(/~~|\*\*/g, '').trim();
                    title = truncate(title);
                    titles.push(`${id}: ${title}`);
                    seen.add(id);
                }
            }
        } catch { /* unreadable — skip */ }
        return titles;
    }

    function buildOutlookPayload({ includeStale = false } = {}) {
        const projects = loadProjects();
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();

        // Active project: reuse /api/status detection via MASTER_PLAN_PATH env
        const activeMasterPlan = process.env.MASTER_PLAN_PATH
            ? path.resolve(process.env.MASTER_PLAN_PATH)
            : null;
        let activeProject = null;

        const rendered = [];
        for (const project of projects) {
            if (project.archived) continue;
            const taskStats = parseTaskStats(project.masterPlan || '');
            const gitInfo = getGitInfo(project.root || '');
            const topInProgress = extractInProgressTitles(project.masterPlan || '', 2);

            // Staleness filter
            const lastCommitMs = gitInfo.lastCommitDate
                ? new Date(gitInfo.lastCommitDate).getTime()
                : 0;
            const isStale = !gitInfo.commits7d && (!lastCommitMs || (now - lastCommitMs > THIRTY_DAYS_MS));
            if (isStale && !includeStale && taskStats.inProgress === 0) continue;

            // Active project match: compare master plan path or project root
            const isActive =
                (activeMasterPlan && project.masterPlan === activeMasterPlan) ||
                (activeMasterPlan && activeMasterPlan.startsWith((project.root || '') + path.sep));
            if (isActive) activeProject = project.name;

            rendered.push({
                name: project.name,
                root: project.root || '',
                taskStats,
                git: {
                    commits7d: gitInfo.commits7d,
                    lastCommitDate: gitInfo.lastCommitDate
                },
                topInProgress
            });
        }

        // Sort: active first, then by 7d commits desc, then by in-progress desc
        rendered.sort((a, b) => {
            if (a.name === activeProject) return -1;
            if (b.name === activeProject) return 1;
            if (b.git.commits7d !== a.git.commits7d) return b.git.commits7d - a.git.commits7d;
            return b.taskStats.inProgress - a.taskStats.inProgress;
        });

        const globalStats = rendered.reduce(
            (acc, p) => {
                acc.totalInProgress += p.taskStats.inProgress;
                acc.totalPlanned += p.taskStats.planned;
                acc.totalDone += p.taskStats.done;
                if (p.git.commits7d > 0) acc.projectsActive7d += 1;
                return acc;
            },
            { totalInProgress: 0, totalPlanned: 0, totalDone: 0, projectsActive7d: 0, projectsTracked: rendered.length }
        );

        return {
            activeProject,
            generatedAt: now,
            projects: rendered,
            globalStats
        };
    }

    function renderOutlookMarkdown(payload) {
        const date = new Date(payload.generatedAt).toISOString().slice(0, 10);
        const lines = [];
        lines.push(`# Cross-Project Outlook — ${date}`);
        lines.push('');
        const active = payload.activeProject || 'none';
        const s = payload.globalStats;
        lines.push(
            `**Active:** ${active} | **Projects:** ${s.projectsTracked} | ` +
            `**In progress:** ${s.totalInProgress} | **Planned:** ${s.totalPlanned} | ` +
            `**Active 7d:** ${s.projectsActive7d}`
        );
        lines.push('');

        for (const p of payload.projects) {
            const marker = p.name === payload.activeProject ? ' _(active)_' : '';
            const commits = p.git.commits7d || 0;
            lines.push(`## ${p.name}${marker} — ${commits} commits/7d`);
            lines.push(
                `- ${p.taskStats.inProgress} in progress, ` +
                `${p.taskStats.planned} planned, ${p.taskStats.done} done`
            );
            if (p.topInProgress.length > 0) {
                lines.push(`- Top: ${p.topInProgress.join(' · ')}`);
            }
            lines.push('');
        }
        lines.push('_Cached up to 5 min. Source: Watchpost /api/outlook._');
        return lines.join('\n');
    }

    app.get('/api/outlook', (req, res) => {
        const format = (req.query.format || 'json').toLowerCase();
        const includeStale = req.query.includeStale === '1' || req.query.includeStale === 'true';

        // Cache read (skip cache when includeStale flag is set — different shape)
        let payload = null;
        if (!includeStale) {
            const cached = readJSON(OUTLOOK_CACHE_FILE, null);
            if (cached && cached.timestamp && (Date.now() - cached.timestamp < OUTLOOK_TTL_MS)) {
                // Invalidate if any tracked MASTER_PLAN.md has been modified since cache
                let stale = false;
                try {
                    const projects = loadProjects();
                    for (const p of projects) {
                        if (!p.masterPlan || !fs.existsSync(p.masterPlan)) continue;
                        const mtime = fs.statSync(p.masterPlan).mtimeMs;
                        if (mtime > cached.timestamp) { stale = true; break; }
                    }
                } catch { /* fall through to rebuild */ }
                if (!stale) payload = cached.payload;
            }
        }

        if (!payload) {
            payload = buildOutlookPayload({ includeStale });
            if (!includeStale) {
                try { writeJSON(OUTLOOK_CACHE_FILE, { timestamp: Date.now(), payload }); }
                catch { /* non-fatal */ }
            }
        }

        if (format === 'markdown' || format === 'md') {
            res.type('text/markdown').send(renderOutlookMarkdown(payload));
            return;
        }
        res.json(payload);
    });

    // ── 2. GET /api/projects/:name/stats ───────────────────────────────────

    app.get('/api/projects/:name/stats', (req, res) => {
        const project = findProject(req.params.name);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const tasks = parseTaskStats(project.masterPlan || '');
        const gitInfo = getGitInfo(project.root || '');

        res.json({
            tasks,
            git: {
                commits7d: gitInfo.commits7d,
                lastCommitDate: gitInfo.lastCommitDate
            }
        });
    });

    // ── 3. GET /api/projects/:name/summary ─────────────────────────────────

    app.get('/api/projects/:name/summary', (req, res) => {
        const project = findProject(req.params.name);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const cacheFile = path.join(SUMMARIES_DIR, `${project.name}.json`);
        const ONE_HOUR = 60 * 60 * 1000;

        // Return cached summary if still fresh
        const cached = readJSON(cacheFile, null);
        if (cached && cached.timestamp && (Date.now() - cached.timestamp < ONE_HOUR)) {
            return res.json(cached.summary);
        }

        // Build fresh summary
        const tasks = parseTaskStats(project.masterPlan || '');
        const gitInfo = getGitInfo(project.root || '');

        // Extract titles of recently completed tasks from MASTER_PLAN
        let completedTitles = [];
        try {
            const content = fs.readFileSync(project.masterPlan, 'utf8');
            const lines = content.split('\n');
            for (const line of lines) {
                // Match lines containing ✅ DONE (with or without bold/parens)
                if (/✅\s*(?:\*\*)?DONE(?:\*\*)?/.test(line)) {
                    const titleMatch = line.match(/\|\s*~~?(TASK|BUG|ROAD|IDEA|ISSUE)-\d+~~?\s*[:\-–]?\s*([^|]+)/i);
                    if (titleMatch) {
                        const title = titleMatch[2].replace(/~~|\*\*/g, '').trim();
                        if (title) completedTitles.push(title);
                    }
                }
            }
        } catch { /* ok */ }

        completedTitles = completedTitles.slice(0, 5);

        const commitSummaries = gitInfo.recentCommits.slice(0, 10).map(c => c.message);
        const summary = {
            projectName: project.name,
            period: 'last 7 days',
            taskStats: tasks,
            gitStats: {
                commits7d: gitInfo.commits7d,
                lastCommitDate: gitInfo.lastCommitDate
            },
            recentCompletions: completedTitles,
            recentCommits: commitSummaries,
            narrative: [
                `This week: completed ${tasks.done} tasks across ${gitInfo.commits7d} commits.`,
                completedTitles.length > 0
                    ? `Key completions: ${completedTitles.join('; ')}.`
                    : '',
                commitSummaries.length > 0
                    ? `Recent work: ${commitSummaries.slice(0, 3).join('; ')}.`
                    : ''
            ].filter(Boolean).join(' ')
        };

        writeJSON(cacheFile, { timestamp: Date.now(), summary });
        res.json(summary);
    });

    // ── 4. GET /api/projects/:name/kickstart ───────────────────────────────

    app.get('/api/projects/:name/kickstart', (req, res) => {
        const project = findProject(req.params.name);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const stack = detectTechStack(project.root || '');
        const gitInfo = getGitInfo(project.root || '');

        // Find next task and open bugs from MASTER_PLAN
        let nextTask = null;
        const openBugs = [];

        try {
            const content = fs.readFileSync(project.masterPlan, 'utf8');
            const lines = content.split('\n');

            for (const line of lines) {
                // Look for first non-done task (IN PROGRESS first, then PLANNED)
                if (!nextTask && /🔄\s*(?:\*\*)?IN PROGRESS(?:\*\*)?/.test(line)) {
                    const m = line.match(/(TASK|BUG|ROAD|IDEA|ISSUE)-(\d+)[:\s]+([^|(✅🔄📋⏸️👀]+)/i);
                    if (m) nextTask = { id: `${m[1]}-${m[2]}`, title: m[3].replace(/~~|\*\*/g, '').trim(), status: 'IN PROGRESS' };
                }
                if (!nextTask && /📋\s*(?:\*\*)?PLANNED(?:\*\*)?/.test(line)) {
                    const m = line.match(/(TASK|BUG|ROAD|IDEA|ISSUE)-(\d+)[:\s]+([^|(✅🔄📋⏸️👀]+)/i);
                    if (m) nextTask = { id: `${m[1]}-${m[2]}`, title: m[3].replace(/~~|\*\*/g, '').trim(), status: 'PLANNED' };
                }
                // Collect open BUG-XXX items
                const bugMatch = line.match(/(BUG-\d+)[:\s]+([^|(✅]+)/);
                if (bugMatch && !/✅\s*(?:\*\*)?DONE(?:\*\*)?/.test(line) && !/~~/.test(bugMatch[1])) {
                    const bugTitle = bugMatch[2].replace(/~~|\*\*|📋|🔄|⏸️|👀/g, '').trim();
                    if (bugTitle && openBugs.length < 10) {
                        openBugs.push({ id: bugMatch[1], title: bugTitle });
                    }
                }
            }
        } catch { /* ok */ }

        const recentActivityLines = gitInfo.recentCommits
            .slice(0, 10)
            .map(c => `- ${c.message}`)
            .join('\n') || '- (no recent commits)';

        const nextTaskLine = nextTask
            ? `${nextTask.id}: ${nextTask.title} (${nextTask.status})`
            : '(no pending tasks found in MASTER_PLAN)';

        const openBugsLines = openBugs.length > 0
            ? openBugs.map(b => `- ${b.id}: ${b.title}`).join('\n')
            : '(none)';

        const prompt = `Project: ${project.name}
Path: ${project.root}
Stack: ${stack}

## Recent Activity (last 7 days)
${recentActivityLines}

## Next Recommended Task
${nextTaskLine}

## Open Bugs
${openBugsLines}

Start by reviewing the recent changes and pick up the next task.`;

        res.json({
            path: project.root,
            cdCommand: `cd ${project.root}`,
            prompt
        });
    });

    // ── 5. POST /api/projects/:name/archive ────────────────────────────────

    app.post('/api/projects/:name/archive', (req, res) => {
        const projects = loadProjects();
        const idx = projects.findIndex(p => p.name === req.params.name);
        if (idx === -1) return res.status(404).json({ error: 'Project not found' });

        projects[idx].archived = true;
        saveProjects(projects);
        res.json({ success: true });
    });

    // ── 6. POST /api/projects/:name/unarchive ──────────────────────────────

    app.post('/api/projects/:name/unarchive', (req, res) => {
        const projects = loadProjects();
        const idx = projects.findIndex(p => p.name === req.params.name);
        if (idx === -1) return res.status(404).json({ error: 'Project not found' });

        projects[idx].archived = false;
        saveProjects(projects);
        res.json({ success: true });
    });

    // ── 7. DELETE /api/projects/:name ──────────────────────────────────────

    app.delete('/api/projects/:name', (req, res) => {
        const projects = loadProjects();
        const idx = projects.findIndex(p => p.name === req.params.name);
        if (idx === -1) return res.status(404).json({ error: 'Project not found' });

        projects.splice(idx, 1);
        saveProjects(projects);
        res.json({ success: true, message: 'Removed from registry. Files on disk untouched.' });
    });

    // ── 7b. POST /api/projects/:name/notes ─────────────────────────────────

    app.post('/api/projects/:name/notes', (req, res) => {
        const projects = loadProjects();
        const idx = projects.findIndex(p => p.name === req.params.name);
        if (idx === -1) return res.status(404).json({ error: 'Project not found' });

        projects[idx].notes = req.body.notes || '';
        saveProjects(projects);
        res.json({ success: true });
    });

    // ── 8. GET /api/projects/:name/cover ───────────────────────────────────

    app.get('/api/projects/:name/cover', (req, res) => {
        const cover = findCoverFile(req.params.name);
        if (!cover) return res.status(404).json({ error: 'No cover image found' });

        const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
        res.setHeader('Content-Type', mimeMap[cover.ext] || 'application/octet-stream');
        fs.createReadStream(cover.filePath).pipe(res);
    });

    // GET /api/projects/:name/covers — list all cover versions (current + history)
    app.get('/api/projects/:name/covers', (req, res) => {
        const projectName = req.params.name;
        const current = findCoverFile(projectName);
        const historyDir = path.join(COVERS_DIR, 'history');
        const versions = [];

        // Add current
        if (current) {
            const stat = fs.statSync(current.filePath);
            versions.push({
                url: `/api/projects/${encodeURIComponent(projectName)}/cover`,
                timestamp: stat.mtimeMs,
                date: stat.mtime.toISOString(),
                current: true
            });
        }

        // Add history
        if (fs.existsSync(historyDir)) {
            const prefix = projectName + '_';
            const files = fs.readdirSync(historyDir).filter(f => f.startsWith(prefix));
            for (const f of files) {
                const tsMatch = f.match(/_(\d+)\./);
                if (tsMatch) {
                    versions.push({
                        url: `/api/projects/${encodeURIComponent(projectName)}/covers/${tsMatch[1]}`,
                        timestamp: parseInt(tsMatch[1]),
                        date: new Date(parseInt(tsMatch[1])).toISOString(),
                        current: false
                    });
                }
            }
        }

        versions.sort((a, b) => b.timestamp - a.timestamp);
        res.json(versions);
    });

    // GET /api/projects/:name/covers/:timestamp — serve a specific historical cover
    app.get('/api/projects/:name/covers/:timestamp', (req, res) => {
        const historyDir = path.join(COVERS_DIR, 'history');
        const prefix = `${req.params.name}_${req.params.timestamp}.`;
        if (!fs.existsSync(historyDir)) return res.status(404).json({ error: 'No history' });
        const file = fs.readdirSync(historyDir).find(f => f.startsWith(prefix));
        if (!file) return res.status(404).json({ error: 'Version not found' });
        const ext = path.extname(file).slice(1);
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] || 'image/png';
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.sendFile(path.join(historyDir, file));
    });

    // POST /api/projects/:name/cover/restore — restore a historical cover as current
    app.post('/api/projects/:name/cover/restore', (req, res) => {
        const projectName = req.params.name;
        const { url } = req.body || {};
        if (!url) return res.status(400).json({ error: 'Missing url parameter' });

        // Extract timestamp from URL like /api/projects/foo/covers/1234567890
        const tsMatch = url.match(/\/covers\/(\d+)/);
        if (!tsMatch) return res.status(400).json({ error: 'Invalid cover URL' });

        const timestamp = tsMatch[1];
        const historyDir = path.join(COVERS_DIR, 'history');
        const prefix = `${projectName}_${timestamp}.`;

        if (!fs.existsSync(historyDir)) return res.status(404).json({ error: 'No history directory' });

        const histFile = fs.readdirSync(historyDir).find(f => f.startsWith(prefix));
        if (!histFile) return res.status(404).json({ error: 'Historical cover not found' });

        const histPath = path.join(historyDir, histFile);
        const ext = path.extname(histFile).slice(1) || 'png';

        // Save current cover to history before replacing
        const currentCover = findCoverFile(projectName);
        if (currentCover) {
            const ts = Date.now();
            fs.mkdirSync(historyDir, { recursive: true });
            fs.copyFileSync(currentCover.filePath, path.join(historyDir, `${projectName}_${ts}.${currentCover.ext}`));
        }

        // Copy historical cover to current position
        const destPath = path.join(COVERS_DIR, `${projectName}.${ext}`);
        fs.copyFileSync(histPath, destPath);

        res.json({
            success: true,
            coverUrl: `/api/projects/${encodeURIComponent(projectName)}/cover`
        });
    });

    // ── 9. POST /api/projects/:name/cover (raw body upload) ────────────────

    app.post('/api/projects/:name/cover', (req, res) => {
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        let ext = 'png';
        if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
        else if (contentType.includes('webp')) ext = 'webp';

        // Collect raw body chunks
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (!buffer.length) {
                return res.status(400).json({ error: 'Empty body' });
            }

            fs.mkdirSync(COVERS_DIR, { recursive: true });
            const destPath = path.join(COVERS_DIR, `${req.params.name}.${ext}`);

            // Remove other formats if they exist
            for (const oldExt of ['png', 'jpg', 'jpeg', 'webp']) {
                const old = path.join(COVERS_DIR, `${req.params.name}.${oldExt}`);
                if (old !== destPath && fs.existsSync(old)) {
                    try { fs.unlinkSync(old); } catch { /* ok */ }
                }
            }

            fs.writeFile(destPath, buffer, err => {
                if (err) return res.status(500).json({ error: 'Failed to save cover', details: err.message });
                res.json({
                    success: true,
                    coverUrl: `/api/projects/${encodeURIComponent(req.params.name)}/cover`
                });
            });
        });
        req.on('error', err => res.status(500).json({ error: err.message }));
    });

    // ── 10. POST /api/projects/:name/generate-cover ────────────────────────

    app.post('/api/projects/:name/generate-cover', async (req, res) => {
        const settings = readJSON(SETTINGS_FILE, {});
        const coverApi = settings.coverApi || {};

        // API key: prefer env var, fall back to settings file
        const apiKey = process.env.KIE_API_KEY || process.env.COVER_API_KEY || coverApi.apiKey;
        const provider = coverApi.provider || 'kie';

        if (!apiKey) {
            return res.status(400).json({
                error: 'No API key configured. Set KIE_API_KEY env var or apiKey in ~/.watchpost/settings.json'
            });
        }
        coverApi.apiKey = apiKey;
        coverApi.provider = provider;

        const projectName = req.params.name;

        // Category-based accent color from project path
        const projects = loadProjects();
        const project = projects.find(p => p.name === projectName);
        const root = project?.root || '';
        const categoryColors = {
            'productivity': { accent: 'teal (#4ECDC4)', secondary: 'gold (#D4AF37)' },
            'bots+automation': { accent: 'electric blue (#3B82F6)', secondary: 'silver (#C0C0C0)' },
            'content-creation': { accent: 'warm gold (#F59E0B)', secondary: 'copper (#B87333)' },
            'freelance': { accent: 'emerald green (#10B981)', secondary: 'gold (#D4AF37)' },
            'devops': { accent: 'deep purple (#8B5CF6)', secondary: 'silver (#C0C0C0)' },
            'game-dev': { accent: 'crimson red (#EF4444)', secondary: 'gold (#D4AF37)' },
            'cc-linux-enhancments': { accent: 'orange (#F97316)', secondary: 'brass (#B5A642)' },
            'misc': { accent: 'rose (#EC4899)', secondary: 'silver (#C0C0C0)' }
        };
        const catFolder = root.match(/ai-development\/([^/]+)/)?.[1] || '';
        const colors = categoryColors[catFolder] || { accent: 'teal (#4ECDC4)', secondary: 'gold (#D4AF37)' };

        // Gather project context for a meaningful cover
        const techStack = project?.root ? detectTechStack(project.root) : 'Unknown';

        // Try to get project description from package.json
        let projectDescription = '';
        try {
            const pkgPath = path.join(project.root, 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            projectDescription = pkg.description || '';
        } catch { /* no package.json or no description */ }

        // Try to get context from MASTER_PLAN.md overview section
        let projectPurpose = '';
        if (project?.masterPlan) {
            try {
                const mpContent = fs.readFileSync(project.masterPlan, 'utf8');
                // Look for "## Overview" or "## Project Overview" section
                const overviewMatch = mpContent.match(/##\s*(?:Project\s+)?Overview[^\n]*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
                if (overviewMatch) {
                    // Take first 2 sentences, clean markdown
                    projectPurpose = overviewMatch[1].trim()
                        .replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                        .split(/[.!]\s+/).slice(0, 2).join('. ').substring(0, 200);
                }
            } catch { /* ok */ }
        }

        // Get recent task titles for thematic hints (top 5 active tasks)
        let taskHints = '';
        if (project?.masterPlan) {
            try {
                const mpContent = fs.readFileSync(project.masterPlan, 'utf8');
                const activeTasks = [];
                const taskRegex = /###\s*(?:~~)?(?:TASK|BUG|FEATURE)-\d+(?:~~)?:\s*(.+?)(?:\s*\(.*\))?$/gm;
                let m;
                while ((m = taskRegex.exec(mpContent)) !== null && activeTasks.length < 5) {
                    const title = m[1].trim();
                    if (!title.includes('DONE') && title.length > 5) activeTasks.push(title);
                }
                if (activeTasks.length > 0) taskHints = activeTasks.join(', ');
            } catch { /* ok */ }
        }

        // Build a context string that describes what the project actually does
        const contextParts = [];
        if (projectDescription) contextParts.push(projectDescription);
        if (projectPurpose) contextParts.push(projectPurpose);
        if (taskHints) contextParts.push(`Current work: ${taskHints}`);
        if (techStack && techStack !== 'Unknown') contextParts.push(`Built with ${techStack}`);
        const categoryLabel = catFolder ? catFolder.replace(/[+-]/g, ' ') : '';
        if (categoryLabel) contextParts.push(`Category: ${categoryLabel}`);
        const projectContext = contextParts.join('. ').substring(0, 200);

        // Pure logo — no descriptive text, no project metadata
        const defaultPrompt = `Art Deco logo for "${projectName}". ` +
            `Dark charcoal #1a1a2e background. ` +
            `The name "${projectName}" in large bold Art Deco geometric lettering colored ${colors.accent}. ` +
            `One simple geometric icon in ${colors.secondary} line art. ` +
            `Decorative Art Deco border frame. ` +
            `Logo design, minimal, clean, flat vector. ` +
            `Only the name "${projectName}" as text, absolutely nothing else written.`;
        const prompt = (req.body && req.body.prompt) ? req.body.prompt : defaultPrompt;

        try {
            let imageBuffer = null;

            if (coverApi.provider === 'openai') {
                const endpoint = 'https://api.openai.com/v1/images/generations';
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${coverApi.apiKey}`
                    },
                    body: JSON.stringify({ prompt, n: 1, size: '512x512', response_format: 'url' })
                });
                const data = await response.json();
                if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
                const imageUrl = data.data && data.data[0] && data.data[0].url;
                if (!imageUrl) throw new Error('No image URL in OpenAI response');
                const imgResponse = await fetch(imageUrl);
                imageBuffer = Buffer.from(await imgResponse.arrayBuffer());

            } else if (coverApi.provider === 'fal') {
                const endpoint = coverApi.endpoint || 'https://fal.run/fal-ai/flux/schnell';
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Key ${coverApi.apiKey}`
                    },
                    body: JSON.stringify({ prompt, image_size: 'square', num_images: 1 })
                });
                const data = await response.json();
                if (data.error) throw new Error(JSON.stringify(data.error));
                const imageUrl = data.images && data.images[0] && data.images[0].url;
                if (!imageUrl) throw new Error('No image URL in fal response');
                const imgResponse = await fetch(imageUrl);
                imageBuffer = Buffer.from(await imgResponse.arrayBuffer());

            } else if (coverApi.provider === 'ideogram' || coverApi.provider === 'ideogram-v3') {
                // Ideogram V3 via Kie.ai — best for Art Deco typography + style
                const genResponse = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${coverApi.apiKey}`
                    },
                    body: JSON.stringify({
                        model: 'ideogram/v3-text-to-image',
                        input: {
                            prompt,
                            rendering_speed: 'QUALITY',
                            style: 'DESIGN',
                            expand_prompt: false,
                            image_size: 'landscape_4_3',
                            negative_prompt: 'text, typography, words, letters, writing, labels, captions, watermarks, bullet points, paragraphs, descriptions, annotations, subtitles, taglines, fine print, small text, multiple text elements, status text, tech stack, project details, information box, blurry, photorealistic, 3D render'
                        }
                    })
                });
                const genData = await genResponse.json();
                if (genData.code !== 200) throw new Error(genData.msg || JSON.stringify(genData));
                const taskId = genData.data?.taskId;
                if (!taskId) throw new Error('No taskId in Ideogram response');

                // Poll for result (max 120 seconds, every 5 seconds)
                let imageUrl = null;
                for (let i = 0; i < 24; i++) {
                    await new Promise(r => setTimeout(r, 5000));
                    const pollResponse = await fetch(
                        `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`,
                        { headers: { 'Authorization': `Bearer ${coverApi.apiKey}` } }
                    );
                    const pollData = await pollResponse.json();
                    const state = pollData.data?.state;
                    if (state === 'success') {
                        const resultJson = JSON.parse(pollData.data?.resultJson || '{}');
                        imageUrl = resultJson.resultUrls?.[0];
                        break;
                    } else if (state === 'fail') {
                        throw new Error('Ideogram generation failed');
                    }
                    // waiting/queuing/generating — continue polling
                }
                if (!imageUrl) throw new Error('Ideogram generation timed out (120s)');
                const imgResponse = await fetch(imageUrl);
                imageBuffer = Buffer.from(await imgResponse.arrayBuffer());

            } else if (coverApi.provider === '4o' || coverApi.provider === 'gpt-image' || coverApi.provider === 'kie' || coverApi.provider === 'kie.ai') {
                // Kie.ai GPT-Image-1 (4o) API — best for text rendering
                // Falls back to Flux Kontext if provider is explicitly 'kie'
                const use4o = coverApi.provider === '4o' || coverApi.provider === 'gpt-image' || coverApi.provider === 'kie' || coverApi.provider === 'kie.ai';
                const genEndpoint = 'https://api.kie.ai/api/v1/gpt4o-image/generate';
                const pollEndpoint = 'https://api.kie.ai/api/v1/gpt4o-image/record-info';

                const genResponse = await fetch(genEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${coverApi.apiKey}`
                    },
                    body: JSON.stringify({
                        prompt,
                        size: '1:1'
                    })
                });
                const genData = await genResponse.json();
                if (genData.code !== 200) throw new Error(genData.msg || JSON.stringify(genData));
                const taskId = genData.data?.taskId;
                if (!taskId) throw new Error('No taskId in Kie.ai response');

                // Poll for result (max 90 seconds, every 4 seconds)
                let imageUrl = null;
                for (let i = 0; i < 22; i++) {
                    await new Promise(r => setTimeout(r, 4000));
                    const pollResponse = await fetch(
                        `${pollEndpoint}?taskId=${taskId}`,
                        { headers: { 'Authorization': `Bearer ${coverApi.apiKey}` } }
                    );
                    const pollData = await pollResponse.json();
                    const flag = pollData.data?.successFlag;
                    if (flag === 1) {
                        // 4o returns resultUrls array, Flux returns resultImageUrl
                        const urls = pollData.data?.response?.resultUrls || pollData.data?.response?.result_urls || [];
                        imageUrl = urls[0] || pollData.data?.response?.resultImageUrl;
                        break;
                    } else if (flag === 2 || flag === 3) {
                        throw new Error(pollData.data?.errorMessage || 'Generation failed');
                    }
                    // flag 0 = still generating, continue polling
                }
                if (!imageUrl) throw new Error('Generation timed out (90s)');
                const imgResponse = await fetch(imageUrl);
                imageBuffer = Buffer.from(await imgResponse.arrayBuffer());

            } else {
                return res.status(400).json({ error: `Unknown provider: ${coverApi.provider}` });
            }

            fs.mkdirSync(COVERS_DIR, { recursive: true });
            const destPath = path.join(COVERS_DIR, `${projectName}.png`);
            // Save previous cover to history before overwriting
            const existingCover = findCoverFile(projectName);
            if (existingCover) {
                const historyDir = path.join(COVERS_DIR, 'history');
                fs.mkdirSync(historyDir, { recursive: true });
                const ts = Date.now();
                fs.copyFileSync(existingCover.filePath, path.join(historyDir, `${projectName}_${ts}.${existingCover.ext}`));
            }
            fs.writeFileSync(destPath, imageBuffer);

            res.json({
                success: true,
                coverUrl: `/api/projects/${encodeURIComponent(projectName)}/cover`
            });

        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── 11. GET /api/notes ─────────────────────────────────────────────────

    app.get('/api/notes', (req, res) => {
        const notes = readJSON(NOTES_FILE, []);
        res.json(Array.isArray(notes) ? notes : []);
    });

    // ── 12. POST /api/notes ────────────────────────────────────────────────

    app.post('/api/notes', (req, res) => {
        const { text, type } = req.body || {};
        if (!text) return res.status(400).json({ error: 'text is required' });

        const notes = readJSON(NOTES_FILE, []);
        const note = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            text,
            type: type || 'note',
            done: false,
            createdAt: new Date().toISOString()
        };

        notes.push(note);
        fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
        writeJSON(NOTES_FILE, notes);
        res.status(201).json(note);
    });

    // ── 13. PATCH /api/notes/:id ───────────────────────────────────────────

    app.patch('/api/notes/:id', (req, res) => {
        const notes = readJSON(NOTES_FILE, []);
        const idx = notes.findIndex(n => n.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Note not found' });

        const allowed = ['text', 'done', 'type'];
        for (const key of allowed) {
            if (req.body && req.body[key] !== undefined) {
                notes[idx][key] = req.body[key];
            }
        }

        writeJSON(NOTES_FILE, notes);
        res.json(notes[idx]);
    });

    // ── 14. DELETE /api/notes/:id ──────────────────────────────────────────

    app.delete('/api/notes/:id', (req, res) => {
        const notes = readJSON(NOTES_FILE, []);
        const idx = notes.findIndex(n => n.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Note not found' });

        notes.splice(idx, 1);
        writeJSON(NOTES_FILE, notes);
        res.json({ success: true });
    });

    // ── 15. GET /api/settings ──────────────────────────────────────────────

    app.get('/api/settings', (req, res) => {
        const defaults = {
            coverApi: { provider: null, apiKey: null, endpoint: null }
        };
        const settings = readJSON(SETTINGS_FILE, defaults);
        // Merge so defaults are always present
        res.json(Object.assign({}, defaults, settings));
    });

    // ── 16. PUT /api/settings ──────────────────────────────────────────────

    app.put('/api/settings', (req, res) => {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'JSON body required' });
        }
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        writeJSON(SETTINGS_FILE, req.body);
        res.json(req.body);
    });

    // ── Changelog helpers ──────────────────────────────────────────────────

    /**
     * List project subdirectory names in CHANGELOG_DIR (excludes _ prefixed files).
     */
    function listChangelogProjects() {
        try {
            return fs.readdirSync(CHANGELOG_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith('_'))
                .map(d => d.name)
                .sort();
        } catch {
            return [];
        }
    }

    /**
     * Generate a list of YYYY-MM-DD date strings for the last N days (inclusive today).
     */
    function lastNDays(n) {
        const dates = [];
        for (let i = 0; i < n; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            dates.push(d.toISOString().slice(0, 10));
        }
        return dates;
    }

    /**
     * Read and parse JSONL entries for one project over the last N days.
     * Returns an array of parsed entry objects.
     */
    function readChangelogEntries(projectName, days) {
        const dates = lastNDays(days);
        const entries = [];
        const projectDir = path.join(CHANGELOG_DIR, projectName);

        for (const dateStr of dates) {
            const filePath = path.join(projectDir, `${dateStr}.jsonl`);
            if (!fs.existsSync(filePath)) continue;
            try {
                const lines = fs.readFileSync(filePath, 'utf8').split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const entry = JSON.parse(trimmed);
                        entry.project = entry.project || projectName;
                        entries.push(entry);
                    } catch { /* malformed line */ }
                }
            } catch { /* unreadable file */ }
        }

        return entries;
    }

    // ── 17. GET /api/changelog/projects ───────────────────────────────────

    app.get('/api/changelog/projects', (req, res) => {
        res.json(listChangelogProjects());
    });

    // ── 18. GET /api/changelog ─────────────────────────────────────────────

    app.get('/api/changelog', (req, res) => {
        const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
        const toolFilter = req.query.tool || null;
        const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
        const projectFilter = req.query.project || null;

        const projects = projectFilter ? [projectFilter] : listChangelogProjects();
        let entries = [];

        for (const proj of projects) {
            const projEntries = readChangelogEntries(proj, days);
            entries = entries.concat(projEntries);
        }

        // Apply tool filter
        if (toolFilter) {
            entries = entries.filter(e => e.tool === toolFilter);
        }

        // Sort newest first
        entries.sort((a, b) => {
            const ta = a.ts || '';
            const tb = b.ts || '';
            return tb.localeCompare(ta);
        });

        // Apply limit
        entries = entries.slice(0, limit);

        res.json({ entries, projects: listChangelogProjects() });
    });

    // ── 19. GET /api/changelog/stats ──────────────────────────────────────

    app.get('/api/changelog/stats', (req, res) => {
        const days = Math.min(parseInt(req.query.days, 10) || 7, 90);
        const projectFilter = req.query.project || null;

        const projects = projectFilter ? [projectFilter] : listChangelogProjects();
        let entries = [];

        for (const proj of projects) {
            entries = entries.concat(readChangelogEntries(proj, days));
        }

        const byTool = {};
        const byDay = {};
        const sessionIds = new Set();

        for (const e of entries) {
            // byTool
            if (e.tool) {
                byTool[e.tool] = (byTool[e.tool] || 0) + 1;
            }
            // byDay
            if (e.ts) {
                const day = e.ts.slice(0, 10);
                byDay[day] = (byDay[day] || 0) + 1;
            }
            // sessions
            if (e.sid) sessionIds.add(e.sid);
        }

        res.json({
            totalEvents: entries.length,
            byTool,
            byDay,
            sessions: sessionIds.size
        });
    });

};
