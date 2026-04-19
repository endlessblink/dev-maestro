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
 * Returns { done, inProgress, planned, paused, review, total }
 */
function parseTaskStats(masterPlanPath) {
    const stats = { done: 0, inProgress: 0, planned: 0, paused: 0, review: 0, total: 0 };
    try {
        const content = fs.readFileSync(masterPlanPath, 'utf8');
        // Count status markers — match both (✅ DONE) and ✅ **DONE** formats
        // Only count from ### headers to avoid double-counting from **Status**: lines
        const headers = content.match(/^###\s.+$/gm) || [];
        let doneMatches = 0, inProgressMatches = 0, plannedMatches = 0, pausedMatches = 0, reviewMatches = 0;
        for (const h of headers) {
            if (/✅\s*DONE|✅\s*\*\*DONE\*\*/.test(h)) doneMatches++;
            else if (/🔄\s*IN PROGRESS|🔄\s*\*\*IN PROGRESS\*\*/.test(h)) inProgressMatches++;
            else if (/📋\s*PLANNED|📋\s*\*\*PLANNED\*\*/.test(h)) plannedMatches++;
            else if (/⏸️?\s*PAUSED|⏸️?\s*\*\*PAUSED\*\*/.test(h)) pausedMatches++;
            else if (/👀\s*REVIEW|👀\s*\*\*REVIEW\*\*/.test(h)) reviewMatches++;
        }

        stats.done = doneMatches;
        stats.inProgress = inProgressMatches;
        stats.planned = plannedMatches;
        stats.paused = pausedMatches;
        stats.review = reviewMatches;
        stats.total = doneMatches + inProgressMatches + plannedMatches + pausedMatches + reviewMatches;
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
