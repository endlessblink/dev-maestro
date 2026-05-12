const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
require('dotenv').config();

const wpPaths = require('./lib/paths');
const IS_WIN = wpPaths.IS_WIN;

// Find Claude binary path - check multiple locations
function findClaudeBinary() {
    // 1. Check environment variable
    if (process.env.CLAUDE_BINARY_PATH && fs.existsSync(process.env.CLAUDE_BINARY_PATH)) {
        console.log(`[Claude] Using binary from env: ${process.env.CLAUDE_BINARY_PATH}`);
        return process.env.CLAUDE_BINARY_PATH;
    }

    // 2. Check ~/.local/bin/claude (symlink location). On Windows we additionally
    //    look for claude.cmd / claude.exe in standard install locations.
    const home = wpPaths.home();
    const localBinCandidates = IS_WIN
        ? [
            path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
            path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe')
        ]
        : [path.join(home, '.local', 'bin', 'claude')];
    for (const candidate of localBinCandidates) {
        if (fs.existsSync(candidate)) {
            console.log(`[Claude] Using binary: ${candidate}`);
            return candidate;
        }
    }

    // 3. Search VS Code extensions for Claude Code extension
    const vscodeExtensions = path.join(home, '.vscode', 'extensions');
    if (fs.existsSync(vscodeExtensions)) {
        try {
            const extensions = fs.readdirSync(vscodeExtensions);
            const claudeExt = extensions
                .filter(e => e.startsWith('anthropic.claude-code-'))
                .sort()
                .reverse()[0]; // Get newest version
            if (claudeExt) {
                const binaryPath = path.join(vscodeExtensions, claudeExt, 'resources/native-binary/claude');
                if (fs.existsSync(binaryPath)) {
                    console.log(`[Claude] Using binary from VS Code extension: ${binaryPath}`);
                    return binaryPath;
                }
            }
        } catch (err) {
            console.error('[Claude] Error searching VS Code extensions:', err.message);
        }
    }

    // 4. Try which/where command as last resort (cross-platform)
    try {
        const lookupCmd = IS_WIN ? 'where claude' : 'which claude 2>/dev/null';
        const whichResult = execSync(lookupCmd, { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
        if (whichResult && fs.existsSync(whichResult)) {
            console.log(`[Claude] Using binary from PATH: ${whichResult}`);
            return whichResult;
        }
    } catch (err) {
        // which/where command failed, continue
    }

    console.error('[Claude] WARNING: Claude binary not found!');
    return null;
}

// Cached Claude binary path - resolved once at startup
const CLAUDE_BINARY = findClaudeBinary();

// Health scanner
const healthScanner = require('./scripts/health-scanner');

const app = express();
const PORT = process.env.PORT || 6010;

// Cache for health scan results, keyed per project context
const healthCache = new Map();
const healthScanInProgress = new Set();

// SSE Clients
let clients = [];

// Helper to broadcast logs to SSE clients
const broadcastLog = (message) => {
    // Send log event
    const payload = JSON.stringify({ type: 'log', message });
    clients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
    });
};

function getRegisteredProjects() {
    const projectsFile = wpPaths.projectsFile();
    const outlookPath = path.join(wpPaths.dataDir(), 'outlook.json');

    try {
        const parsed = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
        const projectsRaw = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.projects)
                ? parsed.projects
                : [];

        // Remap stored roots/masterPlan paths through any cross-OS path mappings
        // before path.resolve() touches them — otherwise resolving a Windows
        // path on Linux (or vice versa) produces garbage.
        const projects = projectsRaw.map(p => ({
            ...p,
            root: p?.root ? wpPaths.mapPathToCurrentOS(p.root) : p?.root,
            path: p?.path ? wpPaths.mapPathToCurrentOS(p.path) : p?.path,
            masterPlan: p?.masterPlan ? wpPaths.mapPathToCurrentOS(p.masterPlan) : p?.masterPlan
        }));

        let changed = false;
        let mergedProjects = [...projects];

        try {
            const outlook = JSON.parse(fs.readFileSync(outlookPath, 'utf8'));
            const passiveProjects = Array.isArray(outlook?.payload?.projects) ? outlook.payload.projects : [];

            for (const passiveProject of passiveProjects) {
                const mappedRoot = passiveProject?.root ? wpPaths.mapPathToCurrentOS(passiveProject.root) : null;
                const root = mappedRoot ? path.resolve(mappedRoot) : null;
                const name = passiveProject?.name || (root ? path.basename(root) : null);
                if (!root || !name) continue;

                const exists = mergedProjects.some(project => {
                    const projectRoot = project.root || project.path;
                    return (projectRoot && path.resolve(projectRoot) === root) || project.name === name;
                });

                if (exists) continue;

                const markerPath = path.join(root, '.watchpost.json');
                let masterPlan = null;

                try {
                    if (fs.existsSync(markerPath)) {
                        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
                        if (typeof marker?.masterPlanPath === 'string' && fs.existsSync(marker.masterPlanPath)) {
                            masterPlan = path.resolve(marker.masterPlanPath);
                        }
                    }
                } catch {
                    // Ignore malformed marker files and fall back to common paths.
                }

                if (!masterPlan) {
                    const candidates = [
                        path.join(root, 'docs', 'MASTER_PLAN.md'),
                        path.join(root, 'MASTER_PLAN.md')
                    ];
                    masterPlan = candidates.find(candidate => fs.existsSync(candidate)) || null;
                }

                mergedProjects.push({
                    name,
                    root,
                    masterPlan,
                    modules: [],
                    source: 'auto-discovered',
                    addedAt: new Date().toISOString().slice(0, 10)
                });
                changed = true;
            }
        } catch {
            // Ignore missing outlook.json.
        }

        if (changed) {
            const nextData = Array.isArray(parsed) ? mergedProjects : { ...parsed, projects: mergedProjects };
            fs.writeFileSync(projectsFile, JSON.stringify(nextData, null, 2));
        }

        return mergedProjects;
    } catch (err) {
        console.error('[Locks] Failed to read projects.json:', err.message);
    }

    return [];
}

function getRequestCwd(req) {
    let queryCwd = null;
    if (typeof req?.originalUrl === 'string') {
        const rawQuery = req.originalUrl.split('?')[1] || '';
        const match = rawQuery.match(/(?:^|&)cwd=([^&]*)/);
        if (match) {
            try {
                queryCwd = decodeURIComponent(match[1]);
            } catch {
                queryCwd = match[1];
            }
        }
    }

    if (!queryCwd && typeof req?.query?.cwd === 'string') {
        queryCwd = req.query.cwd;
    }

    const bodyCwd = typeof req?.body?.cwd === 'string' ? req.body.cwd : null;
    const headerCwd = typeof req?.headers?.['x-watchpost-cwd'] === 'string'
        ? req.headers['x-watchpost-cwd']
        : null;

    const raw = queryCwd || bodyCwd || headerCwd;
    if (!raw) return null;

    try {
        return path.resolve(raw);
    } catch {
        return null;
    }
}

function findProjectForCwd(cwd) {
    if (!cwd) return null;

    let bestMatch = null;
    const projects = getRegisteredProjects();

    // On Windows, drive letters and paths are case-insensitive — compare in lowercase.
    const cwdCmp = IS_WIN ? cwd.toLowerCase() : cwd;

    for (const project of projects) {
        const root = project.root || project.path;
        if (!root) continue;
        const rootCmp = IS_WIN ? root.toLowerCase() : root;
        if (!cwdCmp.startsWith(rootCmp)) continue;

        if (!bestMatch || root.length > bestMatch.root.length) {
            bestMatch = { ...project, root };
        }
    }

    if (bestMatch) return bestMatch;

    let current = path.resolve(cwd);
    while (true) {
        const markerPath = path.join(current, '.watchpost.json');
        const hasProjectMarker = fs.existsSync(markerPath);
        const hasDocsMasterPlan = fs.existsSync(path.join(current, 'docs', 'MASTER_PLAN.md'));
        const hasRootMasterPlan = fs.existsSync(path.join(current, 'MASTER_PLAN.md'));
        const hasGitRoot = fs.existsSync(path.join(current, '.git'));

        if (hasProjectMarker || hasDocsMasterPlan || hasRootMasterPlan || hasGitRoot) {
            let masterPlan = null;
            let inferredName = path.basename(current);

            try {
                if (hasProjectMarker) {
                    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
                    if (typeof marker?.masterPlanPath === 'string' && fs.existsSync(marker.masterPlanPath)) {
                        masterPlan = path.resolve(marker.masterPlanPath);
                    }
                    if (typeof marker?.projectName === 'string' && marker.projectName.trim()) {
                        inferredName = marker.projectName.trim();
                    }
                }
            } catch {
                // Ignore malformed marker and fall back to common paths.
            }

            if (!masterPlan) {
                const candidates = [
                    path.join(current, 'docs', 'MASTER_PLAN.md'),
                    path.join(current, 'MASTER_PLAN.md')
                ];
                masterPlan = candidates.find(candidate => fs.existsSync(candidate)) || null;
            }

            const existing = projects.find(project => {
                const projectRoot = project.root || project.path;
                return projectRoot && path.resolve(projectRoot) === current;
            });

            if (existing) {
                return { ...existing, root: path.resolve(existing.root || existing.path) };
            }

            const nextProjects = [...projects, {
                name: inferredName,
                root: current,
                masterPlan,
                modules: [],
                source: 'auto-discovered',
                addedAt: new Date().toISOString().slice(0, 10)
            }];
            const projectsFile = wpPaths.projectsFile();
            let parsed = { projects: [] };
            try {
                parsed = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
            const nextData = Array.isArray(parsed) ? nextProjects : { ...parsed, projects: nextProjects };
            fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
            fs.writeFileSync(projectsFile, JSON.stringify(nextData, null, 2));

            return {
                name: inferredName,
                root: current,
                masterPlan
            };
        }

        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return bestMatch;
}

// Walk every Claude Code session JSONL once, collect distinct cwds, and
// auto-register any that point at a directory containing MASTER_PLAN.md
// (root or docs/) or a .watchpost.json marker. Conservative on purpose —
// we deliberately do NOT register cwds that only have a .git, because users
// run Claude from $HOME and other random ancestors. Idempotent: dedupes
// against existing roots/names. Stored cwds come from per-machine transcripts,
// so they're already in the current OS's path form (no mapPathToCurrentOS
// needed for the discovered path itself).
function discoverFromClaudeTranscripts() {
    const claudeDirs = wpPaths.claudeProjectsDirs();
    if (!claudeDirs || claudeDirs.length === 0) {
        return { discovered: 0, scanned: 0, transcriptCwds: 0, added: [] };
    }

    const cwds = new Set();
    let scanned = 0;

    for (const root of claudeDirs) {
        let projectDirs;
        try { projectDirs = fs.readdirSync(root, { withFileTypes: true }); }
        catch { continue; }
        for (const pd of projectDirs) {
            if (!pd.isDirectory()) continue;
            const dir = path.join(root, pd.name);
            let files;
            try { files = fs.readdirSync(dir); } catch { continue; }
            for (const f of files) {
                if (!f.endsWith('.jsonl')) continue;
                scanned++;
                const fp = path.join(dir, f);
                try {
                    const fd = fs.openSync(fp, 'r');
                    const buf = Buffer.alloc(16 * 1024);
                    const n = fs.readSync(fd, buf, 0, buf.length, 0);
                    fs.closeSync(fd);
                    const text = buf.subarray(0, n).toString('utf8');
                    for (const line of text.split('\n')) {
                        const t = line.trim();
                        if (!t) continue;
                        let row;
                        try { row = JSON.parse(t); } catch { continue; }
                        if (typeof row?.cwd === 'string' && row.cwd) {
                            cwds.add(row.cwd);
                            break;
                        }
                    }
                } catch {
                    // Unreadable transcript — ignore.
                }
            }
        }
    }

    if (cwds.size === 0) return { discovered: 0, scanned, transcriptCwds: 0, added: [] };

    const projectsFile = wpPaths.projectsFile();
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(projectsFile, 'utf8')); }
    catch { parsed = { projects: [] }; }
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.projects) ? parsed.projects : []);

    const knownRoots = new Set();
    const knownNames = new Set();
    for (const p of list) {
        const raw = p?.root || p?.path;
        if (raw) {
            try { knownRoots.add(path.resolve(wpPaths.mapPathToCurrentOS(raw))); } catch {}
        }
        if (p?.name) knownNames.add(p.name);
    }

    const additions = [];
    for (const cwd of cwds) {
        let resolved;
        try { resolved = path.resolve(cwd); } catch { continue; }
        if (knownRoots.has(resolved)) continue;
        try { if (!fs.existsSync(resolved)) continue; } catch { continue; }

        let masterPlan = null;
        const rootMp = path.join(resolved, 'MASTER_PLAN.md');
        const docsMp = path.join(resolved, 'docs', 'MASTER_PLAN.md');
        const marker = path.join(resolved, '.watchpost.json');
        if (fs.existsSync(rootMp)) masterPlan = rootMp;
        else if (fs.existsSync(docsMp)) masterPlan = docsMp;
        else if (fs.existsSync(marker)) {
            try {
                const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
                if (typeof m?.masterPlanPath === 'string' && fs.existsSync(m.masterPlanPath)) {
                    masterPlan = path.resolve(m.masterPlanPath);
                }
            } catch {}
        }
        if (!masterPlan) continue;

        let name = path.basename(resolved);
        if (knownNames.has(name)) {
            name = `${name}-${path.basename(path.dirname(resolved))}`;
            if (knownNames.has(name)) continue;
        }

        additions.push({
            name,
            root: resolved,
            masterPlan,
            modules: [],
            source: 'transcript-discovered',
            addedAt: new Date().toISOString().slice(0, 10)
        });
        knownRoots.add(resolved);
        knownNames.add(name);
    }

    if (additions.length === 0) {
        return { discovered: 0, scanned, transcriptCwds: cwds.size, added: [] };
    }

    const next = [...list, ...additions];
    const nextData = Array.isArray(parsed) ? next : { ...parsed, projects: next };
    fs.writeFileSync(projectsFile, JSON.stringify(nextData, null, 2));
    return {
        discovered: additions.length,
        scanned,
        transcriptCwds: cwds.size,
        added: additions.map(a => ({ name: a.name, root: a.root }))
    };
}

function getDefaultMasterPlanPath() {
    return path.join(__dirname, '../docs/MASTER_PLAN.md');
}

function getConfiguredMasterPlanPath() {
    return process.env.MASTER_PLAN_PATH
        ? path.resolve(process.env.MASTER_PLAN_PATH)
        : getDefaultMasterPlanPath();
}

function getPassiveActiveProject() {
    const outlookPath = path.join(wpPaths.dataDir(), 'outlook.json');

    try {
        const parsed = JSON.parse(fs.readFileSync(outlookPath, 'utf8'));
        const activeProjectName = parsed?.payload?.activeProject;
        if (!activeProjectName) return null;

        const matchedProject = getRegisteredProjects().find(project => project.name === activeProjectName);
        const passiveProject = Array.isArray(parsed?.payload?.projects)
            ? parsed.payload.projects.find(project => project?.name === activeProjectName)
            : null;

        const rawRoot = matchedProject?.root || matchedProject?.path || passiveProject?.root;
        if (!rawRoot) return null;
        const root = wpPaths.mapPathToCurrentOS(rawRoot);

        const masterPlan = matchedProject?.masterPlan
            ? wpPaths.mapPathToCurrentOS(matchedProject.masterPlan)
            : null;

        return {
            source: masterPlan ? 'passive' : 'passive-unregistered',
            cwd: null,
            projectName: matchedProject?.name || passiveProject?.name || path.basename(root),
            projectRoot: path.resolve(root),
            masterPlanPath: masterPlan ? path.resolve(masterPlan) : null
        };
    } catch {
        return null;
    }
}

function getMasterPlanContext(req) {
    const requestCwd = getRequestCwd(req);
    const matchedProject = findProjectForCwd(requestCwd);

    if (matchedProject) {
        return {
            source: matchedProject.masterPlan ? 'cwd' : 'cwd-unregistered',
            cwd: requestCwd,
            projectName: matchedProject.name,
            projectRoot: path.resolve(matchedProject.root),
            masterPlanPath: matchedProject.masterPlan ? path.resolve(matchedProject.masterPlan) : null
        };
    }

    const passiveProject = getPassiveActiveProject();
    if (passiveProject) {
        return passiveProject;
    }

    const configuredPath = getConfiguredMasterPlanPath();
    return {
        source: process.env.MASTER_PLAN_PATH ? 'configured' : 'default',
        cwd: requestCwd,
        projectName: null,
        projectRoot: path.dirname(configuredPath),
        masterPlanPath: configuredPath
    };
}

function getProjectRootForRequest(req) {
    const requestCwd = getRequestCwd(req);
    const matchedProject = findProjectForCwd(requestCwd);

    if (matchedProject?.root) return path.resolve(matchedProject.root);
    if (requestCwd) return requestCwd;

    return getMasterPlanContext(req).projectRoot;
}

function getHealthCacheKey(req) {
    return getProjectRootForRequest(req);
}

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// Enable CORS
app.use(cors());

// Handle favicon requests (prevents CSP errors)
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve static files from current directory
app.use(express.static(__dirname));

// Status API - for Claude to detect if Watchpost is running
app.get('/api/status', (req, res) => {
    const pkg = require('./package.json');
    const context = getMasterPlanContext(req);

    res.json({
        running: true,
        name: 'Watchpost',
        version: pkg.version,
        port: PORT,
        project: context.projectRoot,
        masterPlanPath: context.masterPlanPath,
        projectName: context.projectName,
        requestCwd: context.cwd,
        resolutionSource: context.source,
        uptime: process.uptime(),
        url: `http://localhost:${PORT}`
    });
});

// POST /api/config/project — switch active project at runtime
app.post('/api/config/project', express.json(), (req, res) => {
    const { masterPlanPath } = req.body || {};
    if (!masterPlanPath) return res.status(400).json({ error: 'masterPlanPath required' });
    const resolved = path.resolve(masterPlanPath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found: ' + resolved });
    process.env.MASTER_PLAN_PATH = resolved;
    console.log('[Config] Active project switched to:', resolved);
    res.json({ ok: true, masterPlanPath: resolved });
});

// API Endpoint to get MASTER_PLAN.md content
app.get('/api/master-plan', (req, res) => {
    const { masterPlanPath } = getMasterPlanContext(req);

    if (!masterPlanPath) {
        return res.status(404).json({
            error: 'No MASTER_PLAN.md registered for this project'
        });
    }

    console.log(`[API] Fetching MASTER_PLAN.md from: ${masterPlanPath}`);

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) {
            console.error(`[API] Error reading MASTER_PLAN.md: ${err.message}`);
            return res.status(500).json({
                error: 'Failed to read MASTER_PLAN.md',
                details: err.message,
                path: masterPlanPath
            });
        }
        res.json({ content: data });
    });
});

// Middleware to parse JSON bodies
app.use(express.json());

// Helper to get Master Plan path
const getMasterPlanPath = (req) => getMasterPlanContext(req).masterPlanPath;

// Helper to scan for existing IDs and find the next available one
const getNextId = (content, prefix = 'TASK') => {
    const regex = new RegExp(`${prefix}-(\\d+)`, 'g');
    let maxId = 0;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num) && num > maxId) {
            maxId = num;
        }
    }

    return `${prefix}-${maxId + 1}`;
};

// API Endpoint to get the next available ID
app.get('/api/next-id', (req, res) => {
    const prefix = req.query.prefix || 'TASK';
    const masterPlanPath = getMasterPlanPath(req);

    console.log(`[API] Calculating next ID for prefix: ${prefix}`);

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) {
            console.error(`[API] Error reading MASTER_PLAN.md: ${err.message}`);
            return res.status(500).json({ error: 'Failed to read MASTER_PLAN.md' });
        }

        try {
            const nextId = getNextId(data, prefix);
            res.json({ prefix, nextId });
        } catch (error) {
            console.error(`[API] Error calculating next ID: ${error.message}`);
            res.status(500).json({ error: 'Failed to calculate next ID' });
        }
    });
});

// API Endpoint to update task status
app.post('/api/task/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const masterPlanPath = getMasterPlanPath(req);
    console.log(`[API] Updating task ${id} status to ${status}`);

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read file' });

        const lines = data.split('\n');
        let updated = false;
        let inTargetTask = false;
        let foundStatusLine = false;

        // Status map
        const statusMap = {
            'todo': '',
            'in-progress': '(🔄 IN PROGRESS)',
            'paused': '(⏸️ PAUSED)',
            'review': '(👀 REVIEW)',
            'done': '(✅ DONE)'
        };

        const humanStatusMap = {
            'todo': 'Todo',
            'in-progress': 'In Progress',
            'paused': 'Paused',
            'review': 'Review',
            'done': 'Done'
        };

        const newStatusStr = statusMap[status] || '';
        const newHumanStatus = humanStatusMap[status] || 'Todo';
        const isDone = status === 'done';

        // Regex to match the target task header
        const taskHeaderRegex = new RegExp(`^###\\s+(?:~~)?${id}(?:~~)?:\\s*(.+?)(?:\\s*\\(([^)]+)\\))?$`);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // 1. Find and update Header
            const match = line.match(taskHeaderRegex);
            if (match) {
                const title = match[1].trim();
                const newId = isDone ? `~~${id}~~` : id;
                lines[i] = `### ${newId}: ${title} ${newStatusStr}`.trim();
                updated = true;
                inTargetTask = true;
                continue;
            }

            // Detect next task start (stop processing scope)
            if (inTargetTask && line.startsWith('### ')) {
                inTargetTask = false;
                // If we finished the task but didn't find a status line, we should insert it?
                // Logic below handles insertion if still in task.
            }

            // 2. Update Status Metadata Line if exists
            if (inTargetTask) {
                if (line.trim().startsWith('**Status**:')) {
                    lines[i] = `**Status**: ${newHumanStatus}`;
                    foundStatusLine = true;
                }
            }
        }

        // If we updated header but didn't find status line, we need to insert it
        // We'll have to re-scan or just do a second pass?
        // Or better: Re-read to find insertion point.
        // Let's refine the loop to insert on the fly if needed.
        // Actually, let's keep it simple: If we found header but not status line,
        // we can identify the line index of the header + 1 or + 2 to insert.

        if (updated && !foundStatusLine) {
            // Find header index again
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`###`) && lines[i].includes(id)) {
                    // Start looking for insertion point (after properties, before description)
                    let insertIdx = i + 1;
                    // Skip empty lines or Priority line
                    while (insertIdx < lines.length && (lines[insertIdx].trim() === '' || lines[insertIdx].trim().startsWith('**Priority**:'))) {
                        insertIdx++;
                    }
                    lines.splice(insertIdx, 0, `**Status**: ${newHumanStatus}`);
                    break;
                }
            }
        }

        if (updated) {
            fs.writeFile(masterPlanPath, lines.join('\n'), 'utf8', (err) => {
                if (err) return res.status(500).json({ error: 'Failed to write file' });
                res.json({ success: true, message: 'Status updated' });
            });
        } else {
            res.status(404).json({ error: 'Task not found or format not supported' });
        }
    });
});

// API Endpoint to update task complexity
app.post('/api/task/:id/complexity', (req, res) => {
    const { id } = req.params;
    const { complexity } = req.body;
    const masterPlanPath = getMasterPlanPath(req);
    console.log(`[API] Updating task ${id} complexity to ${complexity}`);

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read file' });

        const lines = data.split('\n');
        let updated = false;
        let inTargetTask = false;
        let foundComplexityLine = false;
        let headerLineIdx = -1;

        // Regex to match the target task header
        const taskHeaderRegex = new RegExp(`^###\\s+(?:~~)?${id}(?:~~)?:`);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Find task header
            if (line.match(taskHeaderRegex)) {
                headerLineIdx = i;
                updated = true;
                inTargetTask = true;
                continue;
            }

            // Detect next task start (stop processing scope)
            if (inTargetTask && line.startsWith('### ')) {
                inTargetTask = false;
            }

            // Update Complexity line if exists
            if (inTargetTask && line.trim().startsWith('**Complexity**:')) {
                lines[i] = `**Complexity**: ${complexity}`;
                foundComplexityLine = true;
            }
        }

        // If we found header but not complexity line, insert it after Priority or after header
        if (updated && !foundComplexityLine && headerLineIdx >= 0) {
            let insertIdx = headerLineIdx + 1;
            // Skip empty lines, Priority line, and Status line to find proper insertion point
            while (insertIdx < lines.length &&
                   (lines[insertIdx].trim() === '' ||
                    lines[insertIdx].trim().startsWith('**Priority**:') ||
                    lines[insertIdx].trim().startsWith('**Status**:'))) {
                insertIdx++;
            }
            // Insert before the next content line, but after Priority if it exists
            // Actually, let's insert right after Priority line if found, otherwise after header
            let priorityIdx = -1;
            for (let j = headerLineIdx + 1; j < lines.length && j < headerLineIdx + 10; j++) {
                if (lines[j].trim().startsWith('**Priority**:')) {
                    priorityIdx = j;
                    break;
                }
                if (lines[j].startsWith('### ')) break;
            }
            insertIdx = priorityIdx >= 0 ? priorityIdx + 1 : headerLineIdx + 1;
            lines.splice(insertIdx, 0, `**Complexity**: ${complexity}`);
        }

        if (updated) {
            fs.writeFile(masterPlanPath, lines.join('\n'), 'utf8', (err) => {
                if (err) return res.status(500).json({ error: 'Failed to write file' });
                res.json({ success: true, message: 'Complexity updated' });
            });
        } else {
            res.status(404).json({ error: 'Task not found' });
        }
    });
});

// API Endpoint to update task properties (priority, etc)
app.post('/api/task/:id', (req, res) => {
    const { id } = req.params;
    const { property, value } = req.body;
    const masterPlanPath = getMasterPlanPath(req);
    console.log(`[API] Updating task ${id} property ${property} to ${value}`);

    if (property !== 'priority') {
        return res.status(400).json({ error: 'Only priority updates supported currently' });
    }

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read file' });

        const lines = data.split('\n');
        let updated = false;
        let inTargetTask = false;
        let headerLineIdx = -1;
        let taskEndIdx = lines.length;

        const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const taskHeaderRegex = new RegExp(`^#{3,4}\\s+(?:~~)?(?:.*?)\\b${escapedId}\\b(?:~~)?(?=\\s|:|$|\\))`);
        const anyTaskHeaderRegex = /^#{3,4}\s+(?:~~)?(?:.*?)(?:TASK|BUG|ISSUE|FEATURE|ROAD|T)-\d+\b/;

        for (let i = 0; i < lines.length; i++) {
            // Detect task start
            if (lines[i].match(taskHeaderRegex)) {
                console.log(`[API] Found task header at line ${i}: ${lines[i]}`);
                inTargetTask = true;
                headerLineIdx = i;
                continue;
            }
            // Detect next task start (stop processing)
            if (inTargetTask && anyTaskHeaderRegex.test(lines[i])) {
                console.log(`[API] End of task scope at line ${i}: ${lines[i]}`);
                taskEndIdx = i;
                break;
            }

            if (inTargetTask) {
                // Look for **Priority**: line
                if (lines[i].trim().startsWith('**Priority**:')) {
                    console.log(`[API] Found priority line at ${i}: ${lines[i]}`);
                    lines[i] = `**Priority**: ${value}`;
                    console.log(`[API] Updated priority line to: ${lines[i]}`);
                    updated = true;
                    break;
                }
            }
        }

        if (!updated && headerLineIdx >= 0) {
            console.log(`[API] Priority line missing for ${id}; inserting one.`);
            let insertIdx = headerLineIdx + 1;

            while (insertIdx < taskEndIdx && lines[insertIdx].trim() === '') {
                insertIdx++;
            }

            lines.splice(insertIdx, 0, `**Priority**: ${value}`);
            updated = true;
        }

        let idCol = -1;
        let priorityCol = -1;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();

            if (!trimmed.startsWith('|')) {
                idCol = -1;
                priorityCol = -1;
                continue;
            }

            const cells = lines[i].split('|');
            const normalized = cells.map(cell => cell.trim().toLowerCase());

            if ((normalized.includes('id') || normalized.includes('task')) && normalized.includes('priority')) {
                idCol = normalized.includes('id') ? normalized.indexOf('id') : normalized.indexOf('task');
                priorityCol = normalized.indexOf('priority');
                continue;
            }

            if (idCol < 0 || priorityCol < 0 || trimmed.includes('---')) continue;

            const rowId = (cells[idCol] || '').replace(/[~*`]/g, '').trim();
            if (rowId !== id) continue;

            const previousPriority = cells[priorityCol] || '';
            const nextPriority = previousPriority.includes('**') ? `**${value}**` : value;
            cells[priorityCol] = ` ${nextPriority} `;
            lines[i] = cells.join('|');
            console.log(`[API] Updated summary table priority for ${id} at line ${i}`);
            updated = true;
        }

        if (updated) {
            fs.writeFile(masterPlanPath, lines.join('\n'), 'utf8', (err) => {
                if (err) return res.status(500).json({ error: 'Failed to write file' });
                res.json({ success: true });
            });
        } else {
            res.status(404).json({ error: 'Task or Priority field not found' });
        }
    });
});

// API Endpoint to delete a task from MASTER_PLAN.md
app.delete('/api/task/:id', (req, res) => {
    const { id } = req.params;
    const masterPlanPath = getMasterPlanPath(req);
    console.log(`[API] Deleting task ${id}`);

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read file' });

        const lines = data.split('\n');
        let deleted = false;

        const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const taskHeaderRegex = new RegExp(`^#{3,4}\\s+(?:~~)?(?:.*?)\\b${escapedId}\\b(?:~~)?(?=\\s|:|$|\\))`);
        const anyTaskHeaderRegex = /^#{3,4}\s+(?:~~)?(?:.*?)(?:TASK|BUG|ISSUE|FEATURE|ROAD|T)-\d+\b/;

        for (let i = 0; i < lines.length; i++) {
            if (!taskHeaderRegex.test(lines[i])) continue;

            let endIdx = lines.length;
            for (let j = i + 1; j < lines.length; j++) {
                if (anyTaskHeaderRegex.test(lines[j])) {
                    endIdx = j;
                    break;
                }
            }

            while (endIdx > i && lines[endIdx - 1].trim() === '') endIdx--;
            lines.splice(i, endIdx - i);
            deleted = true;
            break;
        }

        let idCol = -1;
        const tableRowsToDelete = [];

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();

            if (!trimmed.startsWith('|')) {
                idCol = -1;
                continue;
            }

            const cells = lines[i].split('|');
            const normalized = cells.map(cell => cell.trim().toLowerCase());

            if (normalized.includes('id') || normalized.includes('task')) {
                idCol = normalized.includes('id') ? normalized.indexOf('id') : normalized.indexOf('task');
                continue;
            }

            if (idCol < 0 || trimmed.includes('---')) continue;

            const rowId = (cells[idCol] || '').replace(/[~*`]/g, '').trim();
            if (rowId !== id) continue;

            tableRowsToDelete.push(i);
        }

        for (let i = tableRowsToDelete.length - 1; i >= 0; i--) {
            lines.splice(tableRowsToDelete[i], 1);
            deleted = true;
        }

        if (!deleted) {
            return res.status(404).json({ error: 'Task not found' });
        }

        fs.writeFile(masterPlanPath, lines.join('\n'), 'utf8', (err) => {
            if (err) return res.status(500).json({ error: 'Failed to write file' });
            res.json({ success: true, message: 'Task deleted' });
        });
    });
});

// Health API Endpoints

// GET /api/health - Full health scan (slow, ~30-60s)
app.get('/api/health', async (req, res) => {
    console.log('[API] Starting full health scan...');
    const cacheKey = getHealthCacheKey(req);
    const projectRoot = getProjectRootForRequest(req);

    if (healthScanInProgress.has(cacheKey)) {
        return res.status(429).json({
            error: 'Scan already in progress',
            cached: healthCache.get(cacheKey) || null
        });
    }

    try {
        healthScanInProgress.add(cacheKey);
        const result = await healthScanner.runFullScan({ cwd: projectRoot, onLog: (msg) => broadcastLog(msg) });
        healthCache.set(cacheKey, result);
        healthScanInProgress.delete(cacheKey);

        console.log(`[API] Full scan completed: Score ${result.health.score}/100 (${result.health.grade})`);
        res.json(result);
    } catch (err) {
        healthScanInProgress.delete(cacheKey);
        console.error(`[API] Health scan error: ${err.message}`);
        res.status(500).json({
            error: 'Health scan failed',
            details: err.message
        });
    }
});

// GET /api/health/quick - Quick scan (TS + ESLint only, ~5-10s)
app.get('/api/health/quick', async (req, res) => {
    console.log('[API] Starting quick health scan...');
    const projectRoot = getProjectRootForRequest(req);

    try {
        const result = await healthScanner.runQuickScan({ cwd: projectRoot });
        console.log('[API] Quick scan completed');
        res.json(result);
    } catch (err) {
        console.error(`[API] Quick scan error: ${err.message}`);
        res.status(500).json({
            error: 'Quick scan failed',
            details: err.message
        });
    }
});

// GET /api/health/cached - Return last scan results (instant)
app.get('/api/health/cached', (req, res) => {
    const cacheKey = getHealthCacheKey(req);
    const cached = healthCache.get(cacheKey);

    if (!cached) {
        return res.status(404).json({
            error: 'No cached scan available',
            message: 'Run a full scan first with GET /api/health'
        });
    }

    res.json({
        ...cached,
        fromCache: true,
        cacheAge: Date.now() - new Date(cached.timestamp).getTime()
    });
});

// GET /api/health/status - Check if scan is in progress
app.get('/api/health/status', (req, res) => {
    const cacheKey = getHealthCacheKey(req);
    const cached = healthCache.get(cacheKey);
    res.json({
        scanning: healthScanInProgress.has(cacheKey),
        hasCachedResult: !!cached,
        lastScanTime: cached?.timestamp || null
    });
});

// POST /api/health/scan - Trigger background scan (non-blocking)
app.post('/api/health/scan', (req, res) => {
    const cacheKey = getHealthCacheKey(req);
    const projectRoot = getProjectRootForRequest(req);

    if (healthScanInProgress.has(cacheKey)) {
        return res.status(429).json({
            error: 'Scan already in progress'
        });
    }

    // Start scan in background
    healthScanInProgress.add(cacheKey);
    console.log('[API] Background scan triggered...');

    healthScanner.runFullScan({ cwd: projectRoot, onLog: (msg) => broadcastLog(msg) })
        .then(result => {
            healthCache.set(cacheKey, result);
            healthScanInProgress.delete(cacheKey);
            console.log(`[API] Background scan completed: Score ${result.health.score}/100`);
        })
        .catch(err => {
            healthScanInProgress.delete(cacheKey);
            console.error(`[API] Background scan error: ${err.message}`);
        });

    res.json({
        message: 'Scan started in background',
        checkStatus: '/api/health/status',
        getResults: '/api/health/cached'
    });
});

// GET /api/health/report - Generate AI-friendly markdown report
app.get('/api/health/report', async (req, res) => {
    const excludeArchive = req.query.includeArchive !== 'true';
    const cacheKey = getHealthCacheKey(req);
    const projectRoot = getProjectRootForRequest(req);

    // Use cached results if available, otherwise run a scan
    let scanData = healthCache.get(cacheKey);

    if (!scanData) {
        console.log('[API] No cached results, running full scan for report...');
        try {
            scanData = await healthScanner.runFullScan({ cwd: projectRoot });
            healthCache.set(cacheKey, scanData);
        } catch (err) {
            return res.status(500).json({
                error: 'Failed to generate report',
                details: err.message
            });
        }
    }

    const report = healthScanner.generateReport(scanData, { excludeArchive });

    // Return as markdown with proper content type
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="health-report.md"');
    res.send(report);
});

// GET /api/health/report/json - Return report data as JSON for programmatic use
app.get('/api/health/report/json', async (req, res) => {
    const excludeArchive = req.query.includeArchive !== 'true';
    const cacheKey = getHealthCacheKey(req);
    const projectRoot = getProjectRootForRequest(req);

    let scanData = healthCache.get(cacheKey);

    if (!scanData) {
        console.log('[API] No cached results, running full scan for report...');
        try {
            scanData = await healthScanner.runFullScan({ cwd: projectRoot });
            healthCache.set(cacheKey, scanData);
        } catch (err) {
            return res.status(500).json({
                error: 'Failed to generate report',
                details: err.message
            });
        }
    }

    // Filter archive files if requested
    if (excludeArchive && scanData.results?.typescript?.errors) {
        scanData = JSON.parse(JSON.stringify(scanData)); // Deep clone
        scanData.results.typescript.errors = scanData.results.typescript.errors.filter(
            e => !e.file?.includes('/archive/')
        );
        scanData.results.typescript.count = scanData.results.typescript.errors.length;
    }

    res.json({
        ...scanData,
        reportUrl: '/api/health/report'
    });
});

function parseSkillFrontmatter(content) {
    const meta = {};
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!match) return meta;

    for (const line of match[1].split('\n')) {
        const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!item) continue;
        meta[item[1].trim()] = item[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return meta;
}

function inferSkillCategory(name, description, content) {
    const haystack = `${name} ${description} ${content.slice(0, 1500)}`.toLowerCase();
    const categories = [
        ['memory', ['anytype', 'obsidian', 'vault', 'memory', 'pkm']],
        ['integration', ['whatsapp', 'google', 'sheets', 'mcp', 'api', 'discord']],
        ['media', ['hyperframes', 'video', 'audio', 'image', 'sprite', 'blender']],
        ['review', ['review', 'audit', 'qa', 'tested', 'security', 'verdict']],
        ['research', ['research', 'search', 'analyze', 'assess', 'learn']],
        ['content', ['post', 'slides', 'hebrew', 'copy', 'markdown', 'docs', 'wiki']],
        ['orchestration', ['agent', 'team', 'workflow', 'autopilot', 'ralph', 'ultrawork', 'omx']],
        ['development', ['code', 'build', 'fix', 'debug', 'tdd', 'implement', 'refactor', 'electron', 'linux']],
        ['design', ['design', 'frontend', 'ui', 'ux', 'visual', 'typography', 'animation', 'motion']]
    ];

    for (const [category, keywords] of categories) {
        if (keywords.some(keyword => haystack.includes(keyword))) return category;
    }
    return 'other';
}

function skillKeywords(skill) {
    const stop = new Set(['skill', 'skills', 'when', 'with', 'from', 'this', 'that', 'into', 'your', 'using', 'user', 'asks', 'workflow', 'imported', 'help', 'code', 'files', 'project']);
    return new Set(`${skill.name} ${skill.description || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9-\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !stop.has(word)));
}

function normalizeSkillName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/^\//, '')
        .split(':')
        .filter(Boolean)
        .pop()
        ?.trim() || '';
}

function skillStateFile() {
    return path.join(wpPaths.dataDir(), 'skills-state.json');
}

function readSkillState() {
    try {
        const parsed = JSON.parse(fs.readFileSync(skillStateFile(), 'utf8'));
        const triedSkills = Array.isArray(parsed?.triedSkills) ? parsed.triedSkills : [];
        return {
            triedSkills: triedSkills
                .map(item => ({
                    name: String(item?.name || '').trim(),
                    key: normalizeSkillName(item?.key || item?.name),
                    triedAt: item?.triedAt || null,
                    source: item?.source || 'manual'
                }))
                .filter(item => item.name && item.key)
        };
    } catch {
        return { triedSkills: [] };
    }
}

function writeSkillState(state) {
    const file = skillStateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function markSkillTried(rawName, source = 'manual') {
    const name = String(rawName || '').trim();
    const key = normalizeSkillName(name);
    if (!name || !key) return null;

    const state = readSkillState();
    const next = state.triedSkills.filter(item => item.key !== key);
    const item = { name, key, triedAt: new Date().toISOString(), source };
    next.push(item);
    next.sort((a, b) => a.name.localeCompare(b.name));
    writeSkillState({ ...state, triedSkills: next });
    return item;
}

function sourceFamily(source) {
    if (!source) return 'unknown';
    if (source.startsWith('project:')) return source;
    if (source.startsWith('project ')) return source;
    return source;
}

let skillsUsageCache = { expiresAt: 0, data: null };

const SKILL_USAGE_SCAN_LIMIT = Number(process.env.WATCHPOST_SKILL_USAGE_SCAN_LIMIT || 350);
const SKILL_USAGE_MAX_FILE_BYTES = Number(process.env.WATCHPOST_SKILL_USAGE_MAX_FILE_BYTES || 2 * 1024 * 1024);

function listFilesRecursive(root, predicate, limit = 6000) {
    const files = [];
    const stack = [root];
    while (stack.length && files.length < limit) {
        const current = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (predicate(fullPath)) {
                files.push(fullPath);
                if (files.length >= limit) break;
            }
        }
    }
    return files;
}

function recordSkillUsage(usage, rawName, row) {
    const names = new Set([rawName, normalizeSkillName(rawName)].filter(Boolean));
    if (String(rawName || '').includes(':')) {
        for (const part of String(rawName).split(':')) names.add(normalizeSkillName(part));
    }

    for (const name of names) {
        if (!name) continue;
        if (!usage.has(name)) {
            usage.set(name, { count: 0, lastUsed: null, projects: new Set(), examples: [] });
        }
        const item = usage.get(name);
        item.count += 1;
        const timestamp = typeof row?.timestamp === 'string' ? row.timestamp : null;
        if (timestamp && (!item.lastUsed || timestamp > item.lastUsed)) item.lastUsed = timestamp;
        if (typeof row?.cwd === 'string' && row.cwd) item.projects.add(row.cwd);
        if (item.examples.length < 3) {
            item.examples.push({ timestamp, cwd: row?.cwd || null });
        }
    }
}

function collectSkillUsage() {
    const now = Date.now();
    if (skillsUsageCache.data && skillsUsageCache.expiresAt > now) return skillsUsageCache.data;

    const usage = new Map();
    const files = [];
    for (const dir of wpPaths.claudeProjectsDirs()) {
        files.push(...listFilesRecursive(dir, file => file.endsWith('.jsonl')));
    }

    const recentFiles = files
        .map(file => {
            try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; }
            catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, SKILL_USAGE_SCAN_LIMIT)
        .map(item => item.file);

    let scannedFiles = 0;
    for (const file of recentFiles) {
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (stat.size > SKILL_USAGE_MAX_FILE_BYTES) continue;

        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        scannedFiles += 1;

        for (const line of text.split('\n')) {
            if (!line.includes('"Skill"') && !line.includes('"attributionSkill"')) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }

            const content = row?.message?.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part?.type === 'tool_use' && part?.name === 'Skill' && typeof part?.input?.skill === 'string') {
                        recordSkillUsage(usage, part.input.skill, row);
                    }
                }
            }

            if (typeof row?.attributionSkill === 'string') {
                recordSkillUsage(usage, row.attributionSkill, row);
            }
        }
    }

    const data = { usage, scannedFiles };
    skillsUsageCache = { expiresAt: now + 60_000, data };
    return data;
}

function collectSkillDirs(projectRoot, includeAllProjects = false) {
    const home = wpPaths.home();
    const candidates = [
        { source: 'codex', root: path.join(home, '.codex', 'skills') },
        { source: 'claude', root: path.join(home, '.claude', 'skills') },
        { source: 'agents', root: path.join(home, '.agents', 'skills') },
        { source: 'opencode', root: path.join(home, '.config', 'opencode', 'skills') },
        { source: 'project claude', root: path.join(projectRoot, '.claude', 'skills') },
        { source: 'project codex', root: path.join(projectRoot, '.codex', 'skills') },
        { source: 'project agents', root: path.join(projectRoot, '.agents', 'skills') }
    ];

    if (includeAllProjects) {
        for (const project of getRegisteredProjects()) {
            const root = wpPaths.mapPathToCurrentOS(project.root || project.path);
            if (!root) continue;
            const projectName = project.name || path.basename(root);
            candidates.push(
                { source: `project:${projectName}:claude`, root: path.join(root, '.claude', 'skills') },
                { source: `project:${projectName}:codex`, root: path.join(root, '.codex', 'skills') },
                { source: `project:${projectName}:agents`, root: path.join(root, '.agents', 'skills') }
            );
        }
    }

    const seen = new Set();
    return candidates.filter(candidate => {
        try {
            if (!fs.existsSync(candidate.root)) return false;
            const rootKey = fs.realpathSync.native(path.resolve(candidate.root));
            if (seen.has(rootKey)) return false;
            seen.add(rootKey);
            return true;
        } catch {
            return false;
        }
    });
}

function collectCommandDirs() {
    const home = wpPaths.home();
    return [
        { source: 'opencode commands', root: path.join(home, '.config', 'opencode', 'commands') },
        { source: 'claude commands', root: path.join(home, '.claude', 'commands') }
    ].filter(candidate => {
        try { return fs.existsSync(candidate.root); } catch { return false; }
    });
}

function readSkillInventory(projectRoot, includeAllProjects = false) {
    const skills = [];
    const skillDirs = collectSkillDirs(projectRoot, includeAllProjects);

    for (const skillDir of skillDirs) {
        let entries = [];
        try { entries = fs.readdirSync(skillDir.root, { withFileTypes: true }); } catch { continue; }

        for (const entry of entries.filter(item => item.isDirectory())) {
            const file = path.join(skillDir.root, entry.name, 'SKILL.md');
            if (!fs.existsSync(file)) continue;

            try {
                const content = fs.readFileSync(file, 'utf8');
                const frontmatter = parseSkillFrontmatter(content);
                const heading = content.split('\n').find(line => line.startsWith('# '));
                const name = frontmatter.name || entry.name;
                const description = frontmatter.description
                    || content.split('\n').find(line => line.trim() && !line.startsWith('#') && !line.startsWith('---') && !line.includes(':'))
                    || '';
                const title = heading ? heading.replace(/^#\s+/, '').trim() : name;
                const category = inferSkillCategory(name, description, content);
                const stat = fs.statSync(file);

                skills.push({
                    id: `skill:${skillDir.source}:${entry.name}`,
                    type: 'skill',
                    name,
                    folderName: entry.name,
                    title,
                    description: description.slice(0, 280),
                    category,
                    source: skillDir.source,
                    path: file,
                    modifiedAt: stat.mtime.toISOString(),
                    content
                });
            } catch {
                // Ignore unreadable skill files.
            }
        }
    }
    return skills;
}

function readCommandInventory() {
    const commands = [];
    for (const commandDir of collectCommandDirs()) {
        let entries = [];
        try { entries = fs.readdirSync(commandDir.root, { withFileTypes: true }); } catch { continue; }

        for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.md'))) {
            const file = path.join(commandDir.root, entry.name);
            try {
                const content = fs.readFileSync(file, 'utf8');
                const frontmatter = parseSkillFrontmatter(content);
                const name = entry.name.replace(/\.md$/, '');
                commands.push({
                    id: `command:${commandDir.source}:${name}`,
                    type: 'command',
                    name,
                    title: `/${name}`,
                    description: frontmatter.description || '',
                    source: commandDir.source,
                    path: file,
                    content
                });
            } catch {
                // Ignore unreadable command files.
            }
        }
    }
    return commands;
}

// GET /api/skills - inventory global skills, slash commands, and their relationships.
app.get('/api/skills', (req, res) => {
    try {
        const projectRoot = getProjectRootForRequest(req);
        const includeAllProjects = req.query.scope === 'all-projects';
        const skills = readSkillInventory(projectRoot, includeAllProjects);
        const commands = readCommandInventory();
        const usageData = collectSkillUsage();
        const skillState = readSkillState();
        const triedByKey = new Map(skillState.triedSkills.map(item => [item.key, item]));
        const nodes = [];
        const links = [];
        const linkKeys = new Set();
        const skillByName = new Map();
        const skillNames = new Map();
        const nodeById = new Map();
        const similarPairs = [];
        const categories = [...new Set(skills.map(skill => skill.category))].sort();
        const sources = [...new Set([...skills.map(skill => skill.source), ...commands.map(command => command.source)])].sort();

        function addLink(source, target, type, value = 1) {
            if (!source || !target || source === target) return;
            const key = `${source}|${target}|${type}`;
            if (linkKeys.has(key)) return;
            linkKeys.add(key);
            links.push({ source, target, type, value });
        }

        for (const category of categories) {
            const node = { id: `category:${category}`, type: 'category', name: category, title: category, category };
            nodes.push(node);
            nodeById.set(node.id, node);
        }

        for (const source of sources) {
            const node = { id: `source:${source}`, type: 'source', name: source, title: source, source };
            nodes.push(node);
            nodeById.set(node.id, node);
        }

        for (const skill of skills) {
            const usage = usageData.usage.get(normalizeSkillName(skill.name))
                || usageData.usage.get(normalizeSkillName(skill.folderName))
                || { count: 0, lastUsed: null, projects: new Set(), examples: [] };
            const tried = triedByKey.get(normalizeSkillName(skill.name)) || triedByKey.get(normalizeSkillName(skill.folderName)) || null;
            const sameName = skills.filter(other => other.name === skill.name);
            const duplicateCount = sameName.filter(other => sourceFamily(other.source) === sourceFamily(skill.source)).length;
            const frameworkCopyCount = new Set(sameName.map(other => sourceFamily(other.source))).size;
            const hasCommand = commands.some(command => {
                const text = `${command.name} ${command.content}`.toLowerCase();
                return command.name === skill.name || text.includes(`/${skill.name}`) || text.includes(`/${skill.folderName}`) || text.includes(skill.path.toLowerCase());
            });
            const issues = [];
            if (!skill.description) issues.push('missing description');
            if (duplicateCount > 1) issues.push('duplicate name');
            if (!hasCommand) issues.push('no command wrapper');
            if (usage.count === 0) issues.push('no observed usage');

            const node = {
                ...skill,
                content: undefined,
                issues,
                commandCount: hasCommand ? 1 : 0,
                usage: usage.count,
                lastUsed: usage.lastUsed,
                projectCount: usage.projects.size,
                usageExamples: usage.examples,
                tried: Boolean(tried),
                triedAt: tried?.triedAt || null,
                frameworkCopyCount
            };
            nodes.push(node);
            nodeById.set(node.id, node);
            addLink(node.id, `category:${skill.category}`, 'category', 2);
            addLink(node.id, `source:${skill.source}`, 'source', 1);

            if (!skillByName.has(skill.name)) skillByName.set(skill.name, []);
            skillByName.get(skill.name).push(node);
            skillNames.set(skill.folderName.toLowerCase(), node.id);
            skillNames.set(skill.name.toLowerCase(), node.id);
        }

        for (const command of commands) {
            const node = { ...command, content: undefined, category: 'command' };
            nodes.push(node);
            nodeById.set(node.id, node);
            addLink(command.id, `source:${command.source}`, 'source', 1);

            const commandText = `${command.name}\n${command.content}`.toLowerCase();
            for (const skill of skills) {
                const names = [skill.name, skill.folderName].map(item => item.toLowerCase());
                if (names.some(name => command.name === name || commandText.includes(`/${name}/skill.md`) || commandText.includes(`skill ${name}`) || commandText.includes(`/${name}`))) {
                    addLink(command.id, skill.id, 'invokes', 4);
                }
            }
        }

        for (const duplicateGroup of skillByName.values()) {
            if (duplicateGroup.length < 2) continue;
            const groupsByFamily = new Map();
            for (const node of duplicateGroup) {
                const family = sourceFamily(node.source);
                if (!groupsByFamily.has(family)) groupsByFamily.set(family, []);
                groupsByFamily.get(family).push(node);
            }

            for (const sameFamilyGroup of groupsByFamily.values()) {
                if (sameFamilyGroup.length < 2) continue;
                for (let i = 0; i < sameFamilyGroup.length; i++) {
                    for (let j = i + 1; j < sameFamilyGroup.length; j++) {
                        addLink(sameFamilyGroup[i].id, sameFamilyGroup[j].id, 'duplicate', 5);
                    }
                }
            }

            for (let i = 0; i < duplicateGroup.length; i++) {
                for (let j = i + 1; j < duplicateGroup.length; j++) {
                    if (sourceFamily(duplicateGroup[i].source) !== sourceFamily(duplicateGroup[j].source)) {
                        addLink(duplicateGroup[i].id, duplicateGroup[j].id, 'framework-copy', 2);
                    }
                }
            }
        }

        for (const skill of skills) {
            const content = skill.content.toLowerCase();
            for (const [name, id] of skillNames.entries()) {
                if (id !== skill.id && content.includes(name)) addLink(skill.id, id, 'references', 3);
            }
        }

        const keywordCache = new Map(skills.map(skill => [skill.id, skillKeywords(skill)]));
        for (let i = 0; i < skills.length; i++) {
            for (let j = i + 1; j < skills.length; j++) {
                if (skills[i].category !== skills[j].category) continue;
                const a = keywordCache.get(skills[i].id);
                const b = keywordCache.get(skills[j].id);
                const shared = [...a].filter(word => b.has(word));
                if (shared.length >= 3) {
                    addLink(skills[i].id, skills[j].id, 'similar', Math.min(shared.length, 5));
                    similarPairs.push({ source: skills[i].id, target: skills[j].id, shared, category: skills[i].category });
                }
            }
        }

        const skillNodes = nodes.filter(node => node.type === 'skill');
        const logicalSkillGroups = new Map();
        for (const node of skillNodes) {
            if (!logicalSkillGroups.has(node.name)) logicalSkillGroups.set(node.name, []);
            logicalSkillGroups.get(node.name).push(node);
        }
        const topUsed = [...logicalSkillGroups.values()]
            .map(group => {
                const canonical = [...group].sort((a, b) =>
                    (b.usage || 0) - (a.usage || 0)
                    || String(b.lastUsed || '').localeCompare(String(a.lastUsed || ''))
                    || a.source.localeCompare(b.source)
                )[0];
                const projects = new Set(group.flatMap(node => (node.usageExamples || []).map(example => example.cwd).filter(Boolean)));
                return {
                    id: canonical.id,
                    name: canonical.name,
                    title: canonical.title,
                    usage: canonical.usage,
                    lastUsed: canonical.lastUsed,
                    source: canonical.source,
                    category: canonical.category,
                    projectCount: Math.max(canonical.projectCount || 0, projects.size),
                    copyCount: group.length
                };
            })
            .filter(node => node.usage > 0)
            .sort((a, b) => b.usage - a.usage || String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')))
            .slice(0, 12);
        const usedCategoryCounts = new Map();
        for (const group of logicalSkillGroups.values()) {
            const used = group.some(node => node.usage > 0);
            if (!used) continue;
            const category = group[0]?.category || 'other';
            usedCategoryCounts.set(category, (usedCategoryCounts.get(category) || 0) + 1);
        }
        const recommendedUnused = [...logicalSkillGroups.values()]
            .map(group => {
                const canonical = [...group].sort((a, b) =>
                    (b.commandCount || 0) - (a.commandCount || 0)
                    || Date.parse(b.modifiedAt || 0) - Date.parse(a.modifiedAt || 0)
                    || a.source.localeCompare(b.source)
                )[0];
                if (!canonical || group.some(node => node.usage > 0 || node.tried)) return null;

                const issues = new Set(group.flatMap(node => node.issues || []));
                const modifiedTime = Math.max(...group.map(node => Date.parse(node.modifiedAt || 0)).filter(Number.isFinite), 0);
                const ageDays = modifiedTime ? Math.max(0, Math.round((Date.now() - modifiedTime) / 86_400_000)) : null;
                const categoryAffinity = usedCategoryCounts.get(canonical.category) || 0;
                const hasCommand = group.some(node => node.commandCount > 0);
                const isGlobal = group.some(node => !String(node.source || '').startsWith('project'));
                const hasDescription = !issues.has('missing description');
                const recentBoost = ageDays === null ? 0 : Math.max(0, 12 - Math.min(ageDays, 90) / 8);
                const score = Math.round(
                    35
                    + Math.min(categoryAffinity * 10, 30)
                    + (hasCommand ? 18 : 0)
                    + (isGlobal ? 12 : 4)
                    + (hasDescription ? 10 : 0)
                    + (group.length > 1 ? 6 : 0)
                    + recentBoost
                );
                const reasons = [];
                if (categoryAffinity) reasons.push(`Matches your used ${canonical.category} skills`);
                if (hasCommand) reasons.push('Has a slash-command wrapper');
                if (isGlobal) reasons.push('Available globally');
                if (group.length > 1) reasons.push(`${group.length} physical copies found`);
                if (ageDays !== null && ageDays <= 30) reasons.push('Recently updated');
                if (!reasons.length) reasons.push('Unused skill worth reviewing');

                return {
                    id: canonical.id,
                    name: canonical.name,
                    title: canonical.title,
                    description: canonical.description,
                    source: canonical.source,
                    category: canonical.category,
                    score,
                    reasons,
                    copyCount: group.length,
                    hasCommand,
                    ageDays,
                    issues: [...issues]
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
            .slice(0, 18);
        const unused = [...skillNodes]
            .filter(node => node.usage === 0)
            .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
            .slice(0, 20)
            .map(node => ({ id: node.id, name: node.name, title: node.title, source: node.source, category: node.category, issues: node.issues }));
        const duplicateGroups = [...skillByName.values()]
            .filter(group => group.length > 1)
            .map(group => group.filter((node, _idx, all) => all.filter(other => sourceFamily(other.source) === sourceFamily(node.source)).length > 1))
            .filter(group => group.length > 1)
            .map(group => ({
                reason: 'Duplicate skill name inside the same source',
                score: 100 + group.length * 5,
                skills: group.map(node => ({ id: node.id, name: node.name, title: node.title, source: node.source, usage: node.usage, lastUsed: node.lastUsed }))
            }));
        const frameworkCopies = [...skillByName.values()]
            .filter(group => group.length > 1)
            .filter(group => new Set(group.map(node => sourceFamily(node.source))).size > 1)
            .map(group => ({
                name: group[0].name,
                count: group.length,
                sources: [...new Set(group.map(node => node.source))].sort(),
                skills: group.map(node => ({ id: node.id, name: node.name, title: node.title, source: node.source, usage: node.usage, lastUsed: node.lastUsed }))
            }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        const similarGroups = similarPairs
            .map(pair => {
                const a = nodeById.get(pair.source);
                const b = nodeById.get(pair.target);
                if (!a || !b) return null;
                const usageGap = Math.abs((a.usage || 0) - (b.usage || 0));
                return {
                    reason: `Similar ${pair.category} purpose (${pair.shared.slice(0, 4).join(', ')})`,
                    score: pair.shared.length * 10 + (a.usage === 0 || b.usage === 0 ? 15 : 0) - Math.min(usageGap, 20),
                    shared: pair.shared.slice(0, 6),
                    skills: [a, b].map(node => ({ id: node.id, name: node.name, title: node.title, source: node.source, usage: node.usage, lastUsed: node.lastUsed }))
                };
            })
            .filter(Boolean)
            .filter(group => group.score >= 25);
        const consolidation = [...duplicateGroups, ...similarGroups]
            .sort((a, b) => b.score - a.score)
            .slice(0, 16);
        const issueCount = nodes.filter(node => node.type === 'skill' && node.issues?.length).length;
        res.json({
            nodes,
            links,
            insights: {
                topUsed,
                recommendedUnused,
                unused,
                consolidation,
                frameworkCopies: frameworkCopies.slice(0, 24),
                triedSkills: skillState.triedSkills,
                usageSource: 'Claude transcript Skill tool calls plus Watchpost tried state',
                usageScannedFiles: usageData.scannedFiles
            },
            stats: {
                totalSkills: skills.length,
                totalCommands: commands.length,
                categories,
                sources,
                issueCount,
                duplicateNames: duplicateGroups.length,
                frameworkCopyGroups: frameworkCopies.length,
                usedSkills: skillNodes.filter(node => node.usage > 0).length,
                triedSkills: skillState.triedSkills.length,
                untriedSkills: skillNodes.filter(node => node.usage === 0 && !node.tried).length,
                unusedSkills: skillNodes.filter(node => node.usage === 0).length,
                consolidationCount: consolidation.length,
                usageScannedFiles: usageData.scannedFiles,
                scope: includeAllProjects ? 'all-projects' : 'active-project'
            }
        });
    } catch (err) {
        res.json({ nodes: [], links: [], insights: { topUsed: [], unused: [], consolidation: [] }, stats: { totalSkills: 0, totalCommands: 0, categories: [], sources: [], issueCount: 0, duplicateNames: 0 }, error: err.message });
    }
});

app.get('/api/skills/tried', (_req, res) => {
    res.json(readSkillState());
});

app.post('/api/skills/tried', (req, res) => {
    const name = req.body?.name || req.body?.skillName;
    const item = markSkillTried(name, req.body?.source || 'manual');
    if (!item) return res.status(400).json({ error: 'name required' });
    res.json({ ok: true, triedSkill: item, state: readSkillState() });
});

app.delete('/api/skills/tried/:name', (req, res) => {
    const key = normalizeSkillName(req.params.name);
    const state = readSkillState();
    const triedSkills = state.triedSkills.filter(item => item.key !== key);
    writeSkillState({ ...state, triedSkills });
    res.json({ ok: true, state: readSkillState() });
});

// GET /api/docs - Dynamically scan docs/ directory
app.get('/api/docs', (req, res) => {
    const docsDir = path.join(getProjectRootForRequest(req), 'docs');

    try {
        if (!fs.existsSync(docsDir)) {
            return res.json({ nodes: [], links: [] });
        }

        const nodes = [];
        const links = [];
        const categoryColors = {
            'architecture': '#3b82f6',
            'process': '#10b981',
            'reference': '#f59e0b',
            'guide': '#8b5cf6',
            'plan': '#ec4899',
            'default': '#6b7280'
        };

        function scanDir(dir, parentId = null, depth = 0) {
            if (depth > 3) return; // Max depth

            const items = fs.readdirSync(dir, { withFileTypes: true });

            for (const item of items) {
                if (item.name.startsWith('.')) continue;

                const fullPath = path.join(dir, item.name);
                const relativePath = path.relative(docsDir, fullPath);
                const nodeId = `doc-${relativePath.replace(/[/\\]/g, '-')}`;

                if (item.isDirectory()) {
                    // Detect category
                    let category = 'default';
                    const nameLower = item.name.toLowerCase();
                    if (nameLower.includes('arch')) category = 'architecture';
                    else if (nameLower.includes('process') || nameLower.includes('sop')) category = 'process';
                    else if (nameLower.includes('ref')) category = 'reference';
                    else if (nameLower.includes('guide')) category = 'guide';
                    else if (nameLower.includes('plan')) category = 'plan';

                    nodes.push({
                        id: nodeId,
                        name: item.name,
                        title: item.name,
                        type: 'folder',
                        category,
                        color: categoryColors[category] || categoryColors.default
                    });

                    if (parentId) {
                        links.push({ source: parentId, target: nodeId });
                    }

                    scanDir(fullPath, nodeId, depth + 1);
                } else if (item.name.endsWith('.md')) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lines = content.split('\n');
                        const titleLine = lines.find(l => l.startsWith('# '));
                        const title = titleLine ? titleLine.replace('# ', '').trim() : item.name;

                        nodes.push({
                            id: nodeId,
                            name: item.name,
                            title,
                            type: 'file',
                            path: relativePath,
                            category: 'default',
                            color: '#6b7280'
                        });

                        if (parentId) {
                            links.push({ source: parentId, target: nodeId });
                        }
                    } catch (e) {
                        // Skip unreadable files
                    }
                }
            }
        }

        scanDir(docsDir);
        res.json({ nodes, links });
    } catch (err) {
        res.json({ nodes: [], links: [], error: err.message });
    }
});

// GET /api/locks - List active task locks
app.get('/api/locks', (req, res) => {
    try {
        const locks = [];
        const requestCwd = getRequestCwd(req);
        const matchedProject = findProjectForCwd(requestCwd);
        const projects = matchedProject ? [matchedProject] : getRegisteredProjects();

        for (const project of projects) {
            const locksDir = path.join(project.root || project.path || '', '.claude', 'locks');
            if (!locksDir || !fs.existsSync(locksDir)) continue;

            const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'));
            for (const file of files) {
                try {
                    const fullPath = path.join(locksDir, file);
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const lock = JSON.parse(content);

                    if (lock.pid && !isPidAlive(Number(lock.pid))) {
                        try {
                            fs.unlinkSync(fullPath);
                        } catch (err) {
                            console.warn('[Locks] Failed to remove stale lock:', fullPath, err.message);
                        }
                        continue;
                    }

                    const taskId = lock.task_id || file.replace('.lock', '');

                    locks.push({
                        task_id: taskId,
                        session_id: lock.session_id || 'unknown',
                        session_short: (lock.session_id || '').slice(0, 8),
                        locked_at: lock.locked_at || new Date(lock.timestamp * 1000).toLocaleString(),
                        files: lock.files || [],
                        project: project.name || path.basename(project.root || project.path || '')
                    });
                } catch (e) {
                    // Skip invalid lock files.
                }
            }
        }

        res.json({ locks });
    } catch (err) {
        res.json({ locks: [], error: err.message });
    }
});

// Control Room routes (projects/enriched, notes, settings, covers, kickstart, etc.)
require('./controlroom/api')(app);

// VPS monitoring routes (services, health, logs, restart)
require('./vps/api')(app);

// SSE Endpoint for live updates
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial ping
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Add client to list
    clients.push(res);
    console.log(`[API] SSE Client connected. (Total: ${clients.length})`);

    // Keep connection open with heartbeat
    const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
    }, 15000);

    req.on('close', () => {
        console.log(`[API] SSE Client disconnected.`);
        clearInterval(keepAlive);
        clients = clients.filter(c => c !== res);
    });
});

app.post('/api/discover/refresh', (_req, res) => {
    try {
        const result = discoverFromClaudeTranscripts();
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.get('/api/discover/status', (_req, res) => {
    try {
        const projects = getRegisteredProjects();
        res.json({
            ok: true,
            total: projects.length,
            bySource: projects.reduce((acc, p) => {
                const s = p.source || 'manual';
                acc[s] = (acc[s] || 0) + 1;
                return acc;
            }, {})
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = { discoverFromClaudeTranscripts, getRegisteredProjects, findProjectForCwd };

if (require.main === module) {
    const { path: bootstrappedProjectsFile, created: bootstrappedFresh } = wpPaths.ensureProjectsFile();
    if (bootstrappedFresh) {
        console.log(`[Bootstrap] Created empty projects.json at ${bootstrappedProjectsFile}`);
    }

    try {
        const r = discoverFromClaudeTranscripts();
        if (r.discovered > 0) {
            console.log(`[Discover] Auto-registered ${r.discovered} project(s) from Claude transcripts: ${r.added.map(a => a.name).join(', ')}`);
        } else {
            console.log(`[Discover] Scanned ${r.scanned} transcript(s), ${r.transcriptCwds} unique cwd(s), 0 new projects.`);
        }
    } catch (err) {
        console.error('[Discover] Startup discovery failed:', err.message);
    }

    app.listen(PORT, () => {
        console.log(`Watchpost running at http://localhost:${PORT}`);
        console.log(`Serving static files from: ${__dirname}`);
    });
}
