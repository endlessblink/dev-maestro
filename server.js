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
            const parsed = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
            const nextData = Array.isArray(parsed) ? nextProjects : { ...parsed, projects: nextProjects };
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
        const anyTaskHeaderRegex = /^#{3,4}\s+(?:~~)?(?:.*?)(?:TASK|BUG|ISSUE|FEATURE|ROAD)-\d+\b/;

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
        const anyTaskHeaderRegex = /^#{3,4}\s+(?:~~)?(?:.*?)(?:TASK|BUG|ISSUE|FEATURE|ROAD)-\d+\b/;

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

// GET /api/skills - Dynamically scan .claude/skills/ directory
app.get('/api/skills', (req, res) => {
    const skillsDir = path.join(getProjectRootForRequest(req), '.claude', 'skills');

    try {
        if (!fs.existsSync(skillsDir)) {
            return res.json({ nodes: [], links: [] });
        }

        const nodes = [];
        const links = [];
        const categoryColors = {
            'debugging': '#ef4444',
            'architecture': '#3b82f6',
            'workflow': '#10b981',
            'review': '#f59e0b',
            'research': '#8b5cf6',
            'design': '#ec4899',
            'default': '#6b7280'
        };

        const dirs = fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter(d => d.isDirectory());

        for (let i = 0; i < dirs.length; i++) {
            const dir = dirs[i];
            const skillPath = path.join(skillsDir, dir.name, 'SKILL.md');

            if (!fs.existsSync(skillPath)) continue;

            try {
                const content = fs.readFileSync(skillPath, 'utf8');
                const lines = content.split('\n');

                // Extract title from first # heading
                const titleLine = lines.find(l => l.startsWith('# '));
                const title = titleLine ? titleLine.replace('# ', '').trim() : dir.name;

                // Extract description from first paragraph
                const descStart = lines.findIndex(l => l.trim() && !l.startsWith('#'));
                const description = descStart >= 0 ? lines[descStart].slice(0, 150) : '';

                // Detect category from name or content
                let category = 'default';
                const nameLower = dir.name.toLowerCase();
                if (nameLower.includes('debug') || nameLower.includes('fix')) category = 'debugging';
                else if (nameLower.includes('arch') || nameLower.includes('plan')) category = 'architecture';
                else if (nameLower.includes('workflow') || nameLower.includes('ops')) category = 'workflow';
                else if (nameLower.includes('review')) category = 'review';
                else if (nameLower.includes('research') || nameLower.includes('doc')) category = 'research';
                else if (nameLower.includes('design') || nameLower.includes('ui')) category = 'design';

                nodes.push({
                    id: `skill-${i}`,
                    name: dir.name,
                    title,
                    description,
                    category,
                    color: categoryColors[category] || categoryColors.default,
                    usage: 0
                });

                // Find dependencies (skills that reference each other)
                const refs = content.match(/skill[s]?[:\s]+["']?([a-z-]+)["']?/gi) || [];
                for (const ref of refs) {
                    const targetName = ref.replace(/skill[s]?[:\s]+["']?/i, '').replace(/["']$/, '');
                    const targetIdx = dirs.findIndex(d => d.name.toLowerCase().includes(targetName.toLowerCase()));
                    if (targetIdx >= 0 && targetIdx !== i) {
                        links.push({ source: `skill-${i}`, target: `skill-${targetIdx}` });
                    }
                }
            } catch (e) {
                // Skip invalid skill files
            }
        }

        // Compute stats for frontend
        const uniqueCategories = [...new Set(nodes.map(n => n.category))];
        const stats = {
            totalSkills: nodes.length,
            categories: uniqueCategories
        };

        res.json({ nodes, links, stats });
    } catch (err) {
        res.json({ nodes: [], links: [], stats: { totalSkills: 0, categories: [] }, error: err.message });
    }
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

app.listen(PORT, () => {
    console.log(`Watchpost running at http://localhost:${PORT}`);
    console.log(`Serving static files from: ${__dirname}`);
});
