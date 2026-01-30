const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

// ============================================================================
// LOCAL OVERRIDES SYSTEM
// Load user customizations from local/ directory (preserved across updates)
// ============================================================================
const localDir = path.join(__dirname, 'local');
const localConfigPath = path.join(localDir, 'config.json');
const localIconsDir = path.join(localDir, 'icons');
const localCssDir = path.join(localDir, 'css');
const localViewsDir = path.join(localDir, 'views');

// Load local config with defaults
let localConfig = {
    port: 6010,
    autoUpdate: true,
    updateBranch: 'main',
    showUpdateNotifications: true
};

if (fs.existsSync(localConfigPath)) {
    try {
        const userConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
        localConfig = { ...localConfig, ...userConfig };
        console.log('[Config] Loaded local configuration from local/config.json');
    } catch (e) {
        console.warn('[Config] ⚠️ Invalid local/config.json, using defaults:', e.message);
    }
} else {
    console.log('[Config] No local/config.json found, using defaults');
}

// Find Claude binary path - check multiple locations
function findClaudeBinary() {
    // 1. Check environment variable
    if (process.env.CLAUDE_BINARY_PATH && fs.existsSync(process.env.CLAUDE_BINARY_PATH)) {
        console.log(`[Claude] Using binary from env: ${process.env.CLAUDE_BINARY_PATH}`);
        return process.env.CLAUDE_BINARY_PATH;
    }

    // 2. Check ~/.local/bin/claude (symlink location)
    const localBin = path.join(process.env.HOME || '/home', '.local/bin/claude');
    if (fs.existsSync(localBin)) {
        console.log(`[Claude] Using binary from ~/.local/bin: ${localBin}`);
        return localBin;
    }

    // 3. Search VS Code extensions for Claude Code extension
    const vscodeExtensions = path.join(process.env.HOME || '/home', '.vscode/extensions');
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

    // 4. Try which command as last resort
    try {
        const whichResult = execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim();
        if (whichResult && fs.existsSync(whichResult)) {
            console.log(`[Claude] Using binary from which: ${whichResult}`);
            return whichResult;
        }
    } catch (err) {
        // which command failed, continue
    }

    console.error('[Claude] WARNING: Claude binary not found! Orchestration will use fallback questions.');
    return null;
}

// Cached Claude binary path - resolved once at startup
const CLAUDE_BINARY = findClaudeBinary();

// Health scanner
const healthScanner = require('./scripts/health-scanner');

const app = express();
// Use port from: 1) env var, 2) local config, 3) default 6010
const PORT = process.env.PORT || localConfig.port || 6010;

// Orchestrations persistence file
const ORCHESTRATIONS_FILE = path.join(__dirname, 'data', 'orchestrations.json');

// Cache for health scan results
let healthCache = null;
let healthScanInProgress = false;

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

// Helper to broadcast lock changes to SSE clients
const broadcastLocksChanged = () => {
    const payload = JSON.stringify({ type: 'locks-changed' });
    clients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
    });
    console.log(`[SSE] Broadcast locks-changed to ${clients.length} clients`);
};

// Helper to broadcast deferred queue changes
const broadcastDeferredChanged = () => {
    const payload = JSON.stringify({ type: 'deferred-changed' });
    clients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
    });
    console.log(`[SSE] Broadcast deferred-changed to ${clients.length} clients`);
};

// Setup file watchers for real-time updates (after getMasterPlanPath is called)
let locksWatcher = null;
let deferredWatcher = null;

const setupFileWatchers = (projectRoot) => {
    // Watch locks directory
    const locksDir = path.join(projectRoot, '.claude', 'locks');
    if (fs.existsSync(locksDir) && !locksWatcher) {
        try {
            locksWatcher = fs.watch(locksDir, { persistent: false }, (eventType, filename) => {
                if (filename && filename.endsWith('.lock')) {
                    console.log(`[Watch] Lock file ${eventType}: ${filename}`);
                    broadcastLocksChanged();
                }
            });
            console.log(`[Watch] Watching locks directory: ${locksDir}`);
        } catch (err) {
            console.log(`[Watch] Could not watch locks directory: ${err.message}`);
        }
    }

    // Watch deferred queue directory
    const deferredDir = path.join(projectRoot, '.claude', 'deferred-queue');
    if (fs.existsSync(deferredDir) && !deferredWatcher) {
        try {
            deferredWatcher = fs.watch(deferredDir, { persistent: false }, (eventType, filename) => {
                if (filename && filename.endsWith('.json')) {
                    console.log(`[Watch] Deferred queue ${eventType}: ${filename}`);
                    broadcastDeferredChanged();
                }
            });
            console.log(`[Watch] Watching deferred queue: ${deferredDir}`);
        } catch (err) {
            console.log(`[Watch] Could not watch deferred queue: ${err.message}`);
        }
    }
};

// Enable CORS
app.use(cors());

// ============================================================================
// LAYERED STATIC FILE SERVING (local/ overrides first, then defaults)
// ============================================================================

// 1. Serve local icons (highest priority for favicon)
if (fs.existsSync(localIconsDir)) {
    // Custom favicon handler - check local first
    app.get('/favicon.ico', (req, res, next) => {
        const localFavicon = path.join(localIconsDir, 'favicon.ico');
        if (fs.existsSync(localFavicon)) {
            return res.sendFile(localFavicon);
        }
        next();
    });
    app.get('/favicon.svg', (req, res, next) => {
        const localFavicon = path.join(localIconsDir, 'favicon.svg');
        if (fs.existsSync(localFavicon)) {
            return res.sendFile(localFavicon);
        }
        next();
    });
}

// 2. Serve local view overrides (e.g., local/views/kanban/index.html -> /kanban/index.html)
if (fs.existsSync(localViewsDir)) {
    app.use((req, res, next) => {
        // Only handle HTML file requests for views
        const reqPath = req.path;
        // Map request to local views directory
        let localPath;
        if (reqPath.endsWith('/')) {
            localPath = path.join(localViewsDir, reqPath, 'index.html');
        } else if (reqPath.endsWith('.html')) {
            localPath = path.join(localViewsDir, reqPath);
        } else {
            // Try adding /index.html for directory-style requests
            localPath = path.join(localViewsDir, reqPath, 'index.html');
        }

        if (fs.existsSync(localPath)) {
            console.log(`[Override] Serving local view: ${localPath}`);
            return res.sendFile(localPath);
        }
        next();
    });
}

// 3. Serve local CSS at /css/custom.css endpoint
if (fs.existsSync(localCssDir)) {
    app.use('/css', express.static(localCssDir));
}

// 4. Handle favicon requests (fallback - prevents CSP errors)
app.get('/favicon.ico', (req, res, next) => {
    const defaultFavicon = path.join(__dirname, 'favicon.ico');
    if (fs.existsSync(defaultFavicon)) {
        return res.sendFile(defaultFavicon);
    }
    res.status(204).end();
});

// 5. Serve default static files from current directory (fallback)
app.use(express.static(__dirname));

// Status API - for Claude to detect if Dev Maestro is running
app.get('/api/status', (req, res) => {
    const pkg = require('./package.json');
    const defaultPath = path.join(__dirname, '../docs/MASTER_PLAN.md');
    const masterPlanPath = process.env.MASTER_PLAN_PATH
        ? path.resolve(process.env.MASTER_PLAN_PATH)
        : defaultPath;

    res.json({
        running: true,
        name: 'Dev Maestro',
        version: pkg.version,
        port: PORT,
        project: path.dirname(masterPlanPath),
        masterPlanPath: masterPlanPath,
        uptime: process.uptime(),
        url: `http://localhost:${PORT}`
    });
});

// ============================================================================
// RUNTIME CONFIG API - For AI agents to configure Dev Maestro without restart
// ============================================================================

// Helper: Find MASTER_PLAN.md in a directory
const findMasterPlan = (projectRoot) => {
    const locations = [
        path.join(projectRoot, 'MASTER_PLAN.md'),
        path.join(projectRoot, 'docs', 'MASTER_PLAN.md'),
        path.join(projectRoot, 'planning', 'MASTER_PLAN.md'),
        path.join(projectRoot, '.github', 'MASTER_PLAN.md'),
        path.join(projectRoot, 'doc', 'MASTER_PLAN.md')
    ];

    for (const loc of locations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }
    return null;
};

// Helper: Get project root from MASTER_PLAN.md path
const getProjectRoot = (planPath) => {
    const planDir = path.dirname(planPath);
    const planDirname = path.basename(planDir);

    if (['docs', 'doc', 'planning', '.github'].includes(planDirname)) {
        return path.dirname(planDir);
    }
    return planDir;
};

// Helper: Update .env file
const updateEnvFile = (key, value) => {
    const envPath = path.join(__dirname, '.env');
    let content = '';

    if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8');
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(content)) {
            content = content.replace(regex, `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
    } else {
        content = `${key}=${value}\n`;
    }

    fs.writeFileSync(envPath, content);
};

// GET /api/config - Get current configuration
app.get('/api/config', (req, res) => {
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : '';

    res.json({
        masterPlanPath: masterPlanPath,
        projectRoot: projectRoot,
        port: PORT,
        localConfig: localConfig,
        installDir: __dirname
    });
});

// POST /api/config/project - Change project at runtime
// Body: { "path": "/path/to/project" } or { "path": "/path/to/MASTER_PLAN.md" }
app.post('/api/config/project', (req, res) => {
    const { path: inputPath } = req.body;

    if (!inputPath) {
        return res.status(400).json({
            error: 'Missing required field: path',
            usage: 'POST /api/config/project with { "path": "/path/to/project" }'
        });
    }

    // Resolve and validate the path
    const resolvedPath = path.resolve(inputPath);
    let masterPlanPath = '';
    let projectRoot = '';

    if (fs.existsSync(resolvedPath)) {
        const stats = fs.statSync(resolvedPath);

        if (stats.isFile()) {
            // Direct path to a file (should be MASTER_PLAN.md)
            if (path.basename(resolvedPath) !== 'MASTER_PLAN.md') {
                return res.status(400).json({
                    error: 'File must be named MASTER_PLAN.md',
                    provided: path.basename(resolvedPath)
                });
            }
            masterPlanPath = resolvedPath;
            projectRoot = getProjectRoot(masterPlanPath);
        } else if (stats.isDirectory()) {
            // Directory - search for MASTER_PLAN.md
            projectRoot = resolvedPath;
            masterPlanPath = findMasterPlan(projectRoot);

            if (!masterPlanPath) {
                return res.status(404).json({
                    error: 'Could not find MASTER_PLAN.md in project',
                    searched: [
                        'MASTER_PLAN.md',
                        'docs/MASTER_PLAN.md',
                        'planning/MASTER_PLAN.md'
                    ],
                    projectRoot: projectRoot
                });
            }
        }
    } else {
        return res.status(404).json({
            error: 'Path not found',
            path: resolvedPath
        });
    }

    // Update runtime environment
    process.env.MASTER_PLAN_PATH = masterPlanPath;

    // Persist to .env file
    updateEnvFile('MASTER_PLAN_PATH', masterPlanPath);

    console.log(`[Config] Project changed to: ${masterPlanPath}`);

    res.json({
        status: 'ok',
        message: 'Project configured successfully',
        masterPlanPath: masterPlanPath,
        projectRoot: projectRoot
    });
});

// POST /api/config/reload - Reload configuration from .env file
app.post('/api/config/reload', (req, res) => {
    const envPath = path.join(__dirname, '.env');

    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^MASTER_PLAN_PATH=(.+)$/m);

        if (match) {
            process.env.MASTER_PLAN_PATH = match[1].trim().replace(/["']/g, '');
            console.log(`[Config] Reloaded MASTER_PLAN_PATH: ${process.env.MASTER_PLAN_PATH}`);
        }
    }

    res.json({
        status: 'ok',
        masterPlanPath: process.env.MASTER_PLAN_PATH || null
    });
});

// API Endpoint to get MASTER_PLAN.md content
app.get('/api/master-plan', (req, res) => {
    // Default to ../docs/MASTER_PLAN.md relative to this script
    const defaultPath = path.join(__dirname, '../docs/MASTER_PLAN.md');
    // Allow override via env var, resolving relative to CWD or using absolute path
    const masterPlanPath = process.env.MASTER_PLAN_PATH
        ? path.resolve(process.env.MASTER_PLAN_PATH)
        : defaultPath;

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
const getMasterPlanPath = () => {
    const defaultPath = path.join(__dirname, '../docs/MASTER_PLAN.md');
    return process.env.MASTER_PLAN_PATH
        ? path.resolve(process.env.MASTER_PLAN_PATH)
        : defaultPath;
};

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
    const masterPlanPath = getMasterPlanPath();

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
    const masterPlanPath = getMasterPlanPath();
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
    const masterPlanPath = getMasterPlanPath();
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
// NOTE: This must come AFTER /api/task/add in route order, or use next() for 'add'
app.post('/api/task/:id', (req, res, next) => {
    const { id } = req.params;

    // Skip to next route if this is the /add endpoint
    if (id === 'add') {
        return next();
    }

    const { property, value } = req.body;
    const masterPlanPath = getMasterPlanPath();
    console.log(`[API] Updating task ${id} property ${property} to ${value}`);

    if (property !== 'priority') {
        return res.status(400).json({ error: 'Only priority updates supported currently' });
    }

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read file' });

        let content = data;
        const lines = content.split('\n');
        let updated = false;
        let inTargetTask = false;

        // streaming-like line processing
        for (let i = 0; i < lines.length; i++) {
            constline = lines[i];

            // Detect task start
            if (lines[i].match(new RegExp(`^###\\s+(?:~~)?${id}`))) {
                console.log(`[API] Found task header at line ${i}: ${lines[i]}`);
                inTargetTask = true;
                continue;
            }
            // Detect next task start (stop processing)
            if (inTargetTask && lines[i].startsWith('### ')) {
                console.log(`[API] End of task scope at line ${i}: ${lines[i]}`);
                inTargetTask = false;
                break;
            }

            if (inTargetTask) {
                // Look for **Priority**: line
                if (lines[i].trim().startsWith('**Priority**:')) {
                    console.log(`[API] Found priority line at ${i}: ${lines[i]}`);
                    const oldLine = lines[i];
                    lines[i] = `**Priority**: ${value}`;
                    console.log(`[API] Updated priority line to: ${lines[i]}`);
                    updated = true;
                    break;
                }
            }
        }

        if (!updated && inTargetTask) {
            console.log(`[API] logic finished task scope but didnt find Priority line to update.`);
            // Optional: Insert priority line if missing?
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

// ============================================================================
// TASK CREATION API
// ============================================================================

// POST /api/task/add - Add a new task to MASTER_PLAN.md
app.post('/api/task/add', (req, res) => {
    const { title, type = 'TASK', priority = 'Medium', description = '' } = req.body;
    const masterPlanPath = getMasterPlanPath();

    if (!title) {
        return res.status(400).json({ error: 'Missing required field: title' });
    }

    // Validate type
    const validTypes = ['TASK', 'BUG', 'FEATURE', 'ROAD', 'IDEA'];
    const taskType = type.toUpperCase();
    if (!validTypes.includes(taskType)) {
        return res.status(400).json({
            error: `Invalid type: ${type}. Valid types: ${validTypes.join(', ')}`
        });
    }

    console.log(`[API] Adding new ${taskType}: ${title}`);

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) {
            console.error(`[API] Error reading MASTER_PLAN.md: ${err.message}`);
            return res.status(500).json({ error: 'Failed to read MASTER_PLAN.md' });
        }

        // Get next ID
        const nextId = getNextId(data, taskType);
        console.log(`[API] Generated ID: ${nextId}`);

        // Build task block
        const taskBlock = `
### ${nextId}: ${title}

**Priority**: ${priority}
**Status**: Backlog
${description ? `\n${description}\n` : ''}
`;

        // Find where to insert (look for "## Active Tasks" or "## Backlog" section)
        let insertPoint = -1;
        const lines = data.split('\n');

        // Try to find appropriate section
        const sectionMarkers = ['## Active Tasks', '## Backlog', '## Tasks', '## Roadmap'];
        for (const marker of sectionMarkers) {
            const idx = lines.findIndex(line => line.trim().startsWith(marker));
            if (idx !== -1) {
                // Find the next ### or ## after this section header
                for (let i = idx + 1; i < lines.length; i++) {
                    if (lines[i].startsWith('### ') || (lines[i].startsWith('## ') && i > idx)) {
                        insertPoint = i;
                        break;
                    }
                }
                if (insertPoint === -1) {
                    // Section exists but no tasks yet, insert after header
                    insertPoint = idx + 1;
                }
                break;
            }
        }

        let newContent;
        if (insertPoint !== -1) {
            // Insert at found position
            lines.splice(insertPoint, 0, taskBlock);
            newContent = lines.join('\n');
        } else {
            // Append to end of file
            newContent = data + '\n' + taskBlock;
        }

        fs.writeFile(masterPlanPath, newContent, 'utf8', (err) => {
            if (err) {
                console.error(`[API] Error writing MASTER_PLAN.md: ${err.message}`);
                return res.status(500).json({ error: 'Failed to write MASTER_PLAN.md' });
            }

            console.log(`[API] Successfully added ${nextId}`);
            res.json({
                success: true,
                task: {
                    id: nextId,
                    title,
                    type: taskType,
                    priority,
                    status: 'Backlog'
                }
            });
        });
    });
});

// Health API Endpoints

// GET /api/health - Full health scan (slow, ~30-60s)
app.get('/api/health', async (req, res) => {
    console.log('[API] Starting full health scan...');

    if (healthScanInProgress) {
        return res.status(429).json({
            error: 'Scan already in progress',
            cached: healthCache
        });
    }

    try {
        healthScanInProgress = true;
        const result = await healthScanner.runFullScan((msg) => broadcastLog(msg));
        healthCache = result;
        healthScanInProgress = false;

        console.log(`[API] Full scan completed: Score ${result.health.score}/100 (${result.health.grade})`);
        res.json(result);
    } catch (err) {
        healthScanInProgress = false;
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

    try {
        const result = await healthScanner.runQuickScan();
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
    if (!healthCache) {
        return res.status(404).json({
            error: 'No cached scan available',
            message: 'Run a full scan first with GET /api/health'
        });
    }

    res.json({
        ...healthCache,
        fromCache: true,
        cacheAge: Date.now() - new Date(healthCache.timestamp).getTime()
    });
});

// GET /api/health/status - Check if scan is in progress
app.get('/api/health/status', (req, res) => {
    res.json({
        scanning: healthScanInProgress,
        hasCachedResult: !!healthCache,
        lastScanTime: healthCache?.timestamp || null
    });
});

// POST /api/health/scan - Trigger background scan (non-blocking)
app.post('/api/health/scan', (req, res) => {
    if (healthScanInProgress) {
        return res.status(429).json({
            error: 'Scan already in progress'
        });
    }

    // Start scan in background
    healthScanInProgress = true;
    console.log('[API] Background scan triggered...');

    healthScanner.runFullScan((msg) => broadcastLog(msg))
        .then(result => {
            healthCache = result;
            healthScanInProgress = false;
            console.log(`[API] Background scan completed: Score ${result.health.score}/100`);
        })
        .catch(err => {
            healthScanInProgress = false;
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

    // Use cached results if available, otherwise run a scan
    let scanData = healthCache;

    if (!scanData) {
        console.log('[API] No cached results, running full scan for report...');
        try {
            scanData = await healthScanner.runFullScan();
            healthCache = scanData;
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

    let scanData = healthCache;

    if (!scanData) {
        console.log('[API] No cached results, running full scan for report...');
        try {
            scanData = await healthScanner.runFullScan();
            healthCache = scanData;
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
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
    const skillsDir = path.join(projectRoot, '.claude/skills');

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
    const docsDir = path.join(__dirname, '../docs');

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

// ============== BEADS API ==============
const { spawn } = require('child_process');
const BD_PATH = process.env.BD_PATH || `${process.env.HOME}/go/bin/bd`;

// Track running agents
const runningAgents = new Map(); // id -> { process, task, startTime, outputBuffer, clients }

// SSE clients for agent output
const agentOutputClients = new Map(); // agentId -> [res, res, ...]

// Helper to run bd commands
const runBd = (args) => {
    try {
        const result = execSync(`${BD_PATH} ${args} --json`, {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            timeout: 10000
        });
        return JSON.parse(result);
    } catch (err) {
        console.error(`[Beads] Error running bd ${args}:`, err.message);
        return null;
    }
};

// GET /api/beads/list - All issues
app.get('/api/beads/list', (req, res) => {
    const issues = runBd('list --limit 0');
    res.json({ issues: issues || [], error: issues ? null : 'Failed to fetch issues' });
});

// GET /api/beads/ready - Ready issues (unblocked)
app.get('/api/beads/ready', (req, res) => {
    const issues = runBd('ready');
    res.json({ issues: issues || [], error: issues ? null : 'Failed to fetch ready issues' });
});

// GET /api/beads/deps/:id - Dependencies for an issue
app.get('/api/beads/deps/:id', (req, res) => {
    const deps = runBd(`dep list ${req.params.id}`);
    res.json({ dependencies: deps || [], error: deps ? null : 'Failed to fetch dependencies' });
});

// GET /api/beads/graph - Full dependency graph for D3
app.get('/api/beads/graph', (req, res) => {
    const issues = runBd('list --limit 0');
    if (!issues) return res.json({ nodes: [], links: [] });

    const nodes = issues.map(issue => ({
        id: issue.id,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        type: issue.issue_type,
        owner: issue.owner,
        dependencyCount: issue.dependency_count || 0,
        dependentCount: issue.dependent_count || 0
    }));

    // Build links from dependencies
    const links = [];
    for (const issue of issues) {
        if (issue.dependency_count > 0) {
            const deps = runBd(`dep list ${issue.id}`);
            if (deps) {
                for (const dep of deps) {
                    links.push({ source: dep.id, target: issue.id, type: dep.dependency_type });
                }
            }
        }
    }

    res.json({ nodes, links });
});

// Helper: Load supervisor template
const SUPERVISORS_DIR = path.join(__dirname, 'supervisors');

function loadSupervisorTemplate(supervisorType) {
    const templatePath = path.join(SUPERVISORS_DIR, `${supervisorType}-supervisor.md`);
    try {
        if (fs.existsSync(templatePath)) {
            return fs.readFileSync(templatePath, 'utf8');
        }
    } catch (err) {
        console.error(`[Agent] Error loading supervisor template: ${err.message}`);
    }
    return null;
}

// Helper: Create git worktree for agent isolation
function createAgentWorktree(taskId) {
    const projectRoot = path.join(__dirname, '..');
    const worktreePath = path.join(projectRoot, '.agent-worktrees', taskId);
    const branchName = `bd-${taskId}`;

    try {
        // Create worktrees directory if needed
        const worktreesDir = path.join(projectRoot, '.agent-worktrees');
        if (!fs.existsSync(worktreesDir)) {
            fs.mkdirSync(worktreesDir, { recursive: true });
        }

        // Check if worktree already exists
        if (fs.existsSync(worktreePath)) {
            console.log(`[Agent] Worktree already exists at ${worktreePath}`);
            return { worktreePath, branchName, created: false };
        }

        // Create branch if not exists
        try {
            execSync(`git branch ${branchName}`, { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
            console.log(`[Agent] Created branch ${branchName}`);
        } catch (e) {
            // Branch may already exist
            console.log(`[Agent] Branch ${branchName} already exists or error: ${e.message}`);
        }

        // Create worktree
        execSync(`git worktree add "${worktreePath}" ${branchName}`, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: 'pipe'
        });

        console.log(`[Agent] Created worktree at ${worktreePath}`);
        return { worktreePath, branchName, created: true };
    } catch (err) {
        console.error(`[Agent] Error creating worktree: ${err.message}`);
        // Fallback to main project directory
        return { worktreePath: projectRoot, branchName: null, created: false };
    }
}

// Helper: Clean up worktree after agent completes
function cleanupWorktree(taskId) {
    const projectRoot = path.join(__dirname, '..');
    const worktreePath = path.join(projectRoot, '.agent-worktrees', taskId);

    try {
        if (fs.existsSync(worktreePath)) {
            execSync(`git worktree remove "${worktreePath}" --force`, {
                cwd: projectRoot,
                encoding: 'utf8',
                stdio: 'pipe'
            });
            console.log(`[Agent] Removed worktree at ${worktreePath}`);
        }
    } catch (err) {
        console.error(`[Agent] Error removing worktree: ${err.message}`);
    }
}

// GET /api/beads/supervisors - List available supervisors
app.get('/api/beads/supervisors', (req, res) => {
    try {
        const supervisors = [];
        if (fs.existsSync(SUPERVISORS_DIR)) {
            const files = fs.readdirSync(SUPERVISORS_DIR);
            for (const file of files) {
                if (file.endsWith('-supervisor.md')) {
                    const name = file.replace('-supervisor.md', '');
                    supervisors.push({ name, file });
                }
            }
        }
        res.json({ supervisors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/beads/claim/:id - Claim a task AND spawn an agent with supervisor
app.post('/api/beads/claim/:id', (req, res) => {
    const taskId = req.params.id;
    const { supervisorType = 'worker', autoStart = true } = req.body;

    try {
        // First update status in beads
        execSync(`${BD_PATH} update ${taskId} --status in_progress`, {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8'
        });

        // Get task details (bd show returns an array)
        const taskResult = runBd(`show ${taskId}`);
        const taskDetails = Array.isArray(taskResult) ? taskResult[0] : taskResult;
        if (!taskDetails) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // If autoStart, spawn a Claude agent
        if (autoStart) {
            // Check if already running
            if (runningAgents.has(taskId)) {
                return res.json({
                    success: true,
                    claimed_by: 'agent',
                    agent_status: 'already_running',
                    message: 'Agent already working on this task'
                });
            }

            // Create isolated worktree for agent
            const { worktreePath, branchName, created: worktreeCreated } = createAgentWorktree(taskId);

            // Load supervisor template
            const supervisorTemplate = loadSupervisorTemplate(supervisorType);

            // Build the prompt for Claude
            let prompt;
            if (supervisorTemplate) {
                // Use supervisor template with placeholders replaced
                prompt = supervisorTemplate
                    .replace(/\{\{BEAD_ID\}\}/g, taskId)
                    .replace(/---[\s\S]*?---/, '') // Remove YAML frontmatter
                    + `\n\n## Current Task\n\nBEAD_ID: ${taskId}
Title: ${taskDetails.title || 'No title'}
Description: ${taskDetails.description || 'No description'}
Priority: ${taskDetails.priority || 'P3'}
Type: ${taskDetails.issue_type || 'task'}

${branchName ? `You are working on branch: ${branchName}` : ''}

Start working now. Follow the beads workflow.`;
            } else {
                // Fallback to basic prompt
                prompt = `You are working on Beads task: ${taskId}

Title: ${taskDetails.title || 'No title'}
Description: ${taskDetails.description || 'No description'}
Priority: ${taskDetails.priority || 'P3'}
Type: ${taskDetails.issue_type || 'task'}

${branchName ? `Working on branch: ${branchName}` : ''}

Instructions:
1. Read the task requirements carefully
2. Implement the requested changes
3. Test your changes
4. When complete: bd update ${taskId} --status inreview

Start working now. Be thorough and complete the task.`;
            }

            console.log(`[Agent] Spawning ${supervisorType}-supervisor for task ${taskId}...`);
            console.log(`[Agent] Working directory: ${worktreePath}`);

            // Spawn claude process with FIXED configuration
            // Critical: inherit stdin and set ANTHROPIC_API_KEY to empty string
            // Note: --verbose is required when using --print with --output-format stream-json
            const agentProcess = spawn(CLAUDE_BINARY, [
                '--print',
                '--verbose',
                '--output-format', 'stream-json',
                '--dangerously-skip-permissions',
                '--max-turns', '50',
                '-p', prompt
            ], {
                cwd: worktreePath,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }  // Inherit API key from environment
            });

            const agentData = {
                process: agentProcess,
                task: {
                    ...taskDetails,
                    title: taskDetails?.title || `Task ${taskId}`
                },
                taskId: taskId,
                supervisorType: supervisorType,
                worktreePath: worktreePath,
                branchName: branchName,
                startTime: Date.now(),
                outputBuffer: [],
                status: 'running'
            };

            runningAgents.set(taskId, agentData);

            // Handle stdout - parse stream-json events into conversational format
            let jsonBuffer = '';

            // Helper to format tool calls conversationally
            function formatToolCall(name, input) {
                switch (name) {
                    case 'Read':
                        return `📖 Reading file: ${input?.file_path || 'unknown'}`;
                    case 'Write':
                        return `📝 Writing file: ${input?.file_path || 'unknown'}`;
                    case 'Edit':
                        return `✏️ Editing file: ${input?.file_path || 'unknown'}`;
                    case 'Bash':
                        const cmd = input?.command || '';
                        return `💻 Running: ${cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd}`;
                    case 'Grep':
                        return `🔍 Searching for: "${input?.pattern || ''}" in ${input?.path || 'codebase'}`;
                    case 'Glob':
                        return `📁 Finding files: ${input?.pattern || ''}`;
                    case 'Task':
                        return `🤖 Spawning sub-agent: ${input?.description || 'task'}`;
                    case 'TodoWrite':
                        return `📋 Updating task list`;
                    case 'WebSearch':
                        return `🌐 Searching web: ${input?.query || ''}`;
                    case 'WebFetch':
                        return `🌐 Fetching: ${input?.url || ''}`;
                    default:
                        return `🔧 Using ${name}`;
                }
            }

            agentProcess.stdout.on('data', (data) => {
                jsonBuffer += data.toString();

                // Process complete JSON lines
                const lines = jsonBuffer.split('\n');
                jsonBuffer = lines.pop(); // Keep incomplete line in buffer

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const event = JSON.parse(line);

                        // Parse different event types from stream-json format
                        if (event.type === 'assistant' && event.message?.content) {
                            // Process each content block
                            for (const block of event.message.content) {
                                if (block.type === 'text' && block.text?.trim()) {
                                    // Claude's thinking/response text
                                    const text = block.text.trim();
                                    agentData.outputBuffer.push({ type: 'assistant', text, time: Date.now() });
                                    broadcastAgentOutput(taskId, { type: 'assistant', text });
                                } else if (block.type === 'tool_use') {
                                    // Tool being called
                                    const toolText = formatToolCall(block.name, block.input);
                                    agentData.outputBuffer.push({ type: 'tool', text: toolText, tool: block.name, time: Date.now() });
                                    broadcastAgentOutput(taskId, { type: 'tool', text: toolText, tool: block.name });
                                    broadcastLog(`[Agent ${taskId}] ${toolText}`);
                                }
                            }
                        } else if (event.type === 'content_block_delta' && event.delta?.text) {
                            // Streaming text delta (append to current)
                            const text = event.delta.text;
                            if (text.trim()) {
                                agentData.outputBuffer.push({ type: 'assistant', text, time: Date.now() });
                                broadcastAgentOutput(taskId, { type: 'assistant', text });
                            }
                        } else if (event.type === 'result') {
                            // Final result
                            const text = event.subtype === 'success'
                                ? '✅ Task completed successfully!'
                                : `⚠️ Task ended: ${event.subtype}`;
                            agentData.outputBuffer.push({ type: 'result', text, time: Date.now() });
                            broadcastAgentOutput(taskId, { type: 'result', text });
                        } else if (event.type === 'system') {
                            // Skip noisy system messages (init, hooks, internal stuff)
                            const skipSubtypes = ['init', 'hook_response', 'config'];
                            if (skipSubtypes.includes(event.subtype)) continue;
                            // Only show meaningful system messages
                            if (event.message && typeof event.message === 'string') {
                                agentData.outputBuffer.push({ type: 'system', text: `ℹ️ ${event.message}`, time: Date.now() });
                                broadcastAgentOutput(taskId, { type: 'system', text: `ℹ️ ${event.message}` });
                            }
                        }
                        // Skip other event types (like raw init data)
                    } catch (e) {
                        // Not JSON - only show if it looks meaningful
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.startsWith('{') && trimmed.length < 500) {
                            agentData.outputBuffer.push({ type: 'stdout', text: trimmed, time: Date.now() });
                            broadcastAgentOutput(taskId, { type: 'stdout', text: trimmed });
                        }
                    }
                }
            });

            // Handle stderr
            agentProcess.stderr.on('data', (data) => {
                const output = data.toString();
                agentData.outputBuffer.push({ type: 'stderr', text: output, time: Date.now() });
                broadcastAgentOutput(taskId, { type: 'stderr', text: output });
            });

            // Handle exit
            agentProcess.on('close', (code) => {
                console.log(`[Agent] Task ${taskId} agent exited with code ${code}`);
                agentData.status = code === 0 ? 'completed' : 'failed';
                agentData.exitCode = code;
                agentData.endTime = Date.now();

                broadcastAgentOutput(taskId, {
                    type: 'exit',
                    code: code,
                    message: code === 0 ? 'Task completed successfully' : 'Task failed'
                });

                // Clean up after a delay (keep for logs viewing)
                setTimeout(() => {
                    if (runningAgents.get(taskId)?.status !== 'running') {
                        runningAgents.delete(taskId);
                    }
                }, 300000); // 5 minutes
            });

            // Handle error
            agentProcess.on('error', (err) => {
                console.error(`[Agent] Error spawning agent for ${taskId}:`, err.message);
                agentData.status = 'error';
                agentData.error = err.message;
                broadcastAgentOutput(taskId, { type: 'error', message: err.message });
            });

            res.json({
                success: true,
                claimed_by: 'agent',
                agent_status: 'started',
                message: `Agent spawned and working on task ${taskId}`
            });
        } else {
            res.json({ success: true, claimed_by: agent || 'manual' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper to format tool calls conversationally (shared function)
function formatToolCallShared(name, input) {
    switch (name) {
        case 'Read':
            return `📖 Reading file: ${input?.file_path || 'unknown'}`;
        case 'Write':
            return `📝 Writing file: ${input?.file_path || 'unknown'}`;
        case 'Edit':
            return `✏️ Editing file: ${input?.file_path || 'unknown'}`;
        case 'Bash':
            return `🖥️ Running command: ${(input?.command || '').slice(0, 80)}`;
        case 'Grep':
            return `🔍 Searching for: ${input?.pattern || 'pattern'}`;
        case 'Glob':
            return `📁 Finding files: ${input?.pattern || '*'}`;
        case 'Task':
            return `🤖 Spawning agent: ${input?.prompt?.slice(0, 50) || 'subtask'}`;
        case 'WebFetch':
            return `🌐 Fetching: ${input?.url || 'URL'}`;
        case 'WebSearch':
            return `🔎 Searching web: ${input?.query || 'query'}`;
        default:
            return `🔧 Using ${name}`;
    }
}

// Helper to parse stream-json output and broadcast (shared function)
function parseAndBroadcastAgentOutput(taskId, rawData, agentData, jsonBuffer = '') {
    jsonBuffer += rawData;
    const lines = jsonBuffer.split('\n');
    const remainingBuffer = lines.pop(); // Keep incomplete line

    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const event = JSON.parse(line);

            // Parse different event types from stream-json format
            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'text' && block.text?.trim()) {
                        const text = block.text.trim();
                        agentData.outputBuffer.push({ type: 'assistant', text, time: Date.now() });
                        broadcastAgentOutput(taskId, { type: 'assistant', text });
                    } else if (block.type === 'tool_use') {
                        const toolText = formatToolCallShared(block.name, block.input);
                        agentData.outputBuffer.push({ type: 'tool', text: toolText, tool: block.name, time: Date.now() });
                        broadcastAgentOutput(taskId, { type: 'tool', text: toolText, tool: block.name });
                    }
                }
            } else if (event.type === 'content_block_delta' && event.delta?.text) {
                const text = event.delta.text;
                if (text.trim()) {
                    agentData.outputBuffer.push({ type: 'assistant', text, time: Date.now() });
                    broadcastAgentOutput(taskId, { type: 'assistant', text });
                }
            } else if (event.type === 'result') {
                const text = event.subtype === 'success'
                    ? '✅ Task completed successfully!'
                    : `⚠️ Task ended: ${event.subtype}`;
                agentData.outputBuffer.push({ type: 'result', text, time: Date.now() });
                broadcastAgentOutput(taskId, { type: 'result', text });
            } else if (event.type === 'system') {
                // Skip noisy system messages (init, hooks, internal stuff)
                const skipSubtypes = ['init', 'hook_response', 'config'];
                if (skipSubtypes.includes(event.subtype)) continue;
                if (event.message && typeof event.message === 'string') {
                    agentData.outputBuffer.push({ type: 'system', text: `ℹ️ ${event.message}`, time: Date.now() });
                    broadcastAgentOutput(taskId, { type: 'system', text: `ℹ️ ${event.message}` });
                }
            }
            // Skip other event types
        } catch (e) {
            // Not JSON - only show if it looks meaningful
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('{') && trimmed.length < 500) {
                agentData.outputBuffer.push({ type: 'stdout', text: trimmed, time: Date.now() });
                broadcastAgentOutput(taskId, { type: 'stdout', text: trimmed });
            }
        }
    }

    return remainingBuffer;
}

// Helper to broadcast output to agent watchers
function broadcastAgentOutput(taskId, data) {
    const clients = agentOutputClients.get(taskId) || [];
    const payload = JSON.stringify({ taskId, ...data, timestamp: Date.now() });

    clients.forEach(client => {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (e) {
            // Client disconnected
        }
    });
}

// ============================================================================
// ORCHESTRATOR SUB-AGENT OUTPUT HANDLING (TASK-319)
// ============================================================================

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log('[Orchestrator] Created logs directory:', logsDir);
}

// Append to agent log file
function appendAgentLog(taskId, message) {
    const logFile = path.join(logsDir, `agent-${taskId}.log`);
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
}

// Parse and broadcast orchestrator sub-agent output (stream-json format)
// Similar to parseAndBroadcastAgentOutput but uses broadcastOrchestration
function parseAndBroadcastOrchOutput(orchId, taskId, rawData, subAgentData, jsonBuffer = '') {
    jsonBuffer += rawData;
    const lines = jsonBuffer.split('\n');
    const remainingBuffer = lines.pop(); // Keep incomplete line

    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const event = JSON.parse(line);

            // Parse different event types from stream-json format
            if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                    if (block.type === 'text' && block.text?.trim()) {
                        const text = block.text.trim();
                        subAgentData.output.push({ type: 'assistant', text, time: Date.now() });
                        appendAgentLog(taskId, `[ASSISTANT] ${text.substring(0, 200)}`);
                        broadcastOrchestration(orchId, {
                            type: 'agent_output',
                            taskId,
                            outputType: 'assistant',
                            text: text.substring(0, 500) // Limit broadcast size
                        });
                    } else if (block.type === 'tool_use') {
                        const toolText = `🔧 ${block.name}: ${JSON.stringify(block.input || {}).substring(0, 100)}`;
                        subAgentData.output.push({ type: 'tool', text: toolText, tool: block.name, time: Date.now() });
                        appendAgentLog(taskId, `[TOOL] ${block.name}`);
                        broadcastOrchestration(orchId, {
                            type: 'agent_output',
                            taskId,
                            outputType: 'tool',
                            tool: block.name,
                            text: toolText
                        });
                    }
                }
            } else if (event.type === 'content_block_delta' && event.delta?.text) {
                const text = event.delta.text;
                if (text.trim()) {
                    subAgentData.output.push({ type: 'delta', text, time: Date.now() });
                    // Don't broadcast deltas to reduce noise, but log them
                    appendAgentLog(taskId, `[DELTA] ${text.substring(0, 100)}`);
                }
            } else if (event.type === 'result') {
                const text = event.subtype === 'success'
                    ? '✅ Task completed successfully!'
                    : `⚠️ Task ended: ${event.subtype}`;
                subAgentData.output.push({ type: 'result', text, time: Date.now() });
                appendAgentLog(taskId, `[RESULT] ${text}`);
                broadcastOrchestration(orchId, {
                    type: 'agent_output',
                    taskId,
                    outputType: 'result',
                    text
                });
            } else if (event.type === 'system') {
                // Skip noisy system messages
                const skipSubtypes = ['init', 'hook_response', 'config'];
                if (skipSubtypes.includes(event.subtype)) continue;
                if (event.message && typeof event.message === 'string') {
                    subAgentData.output.push({ type: 'system', text: event.message, time: Date.now() });
                    appendAgentLog(taskId, `[SYSTEM] ${event.message}`);
                }
            }
        } catch (e) {
            // Not JSON - log meaningful non-JSON output
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('{') && trimmed.length < 500) {
                subAgentData.output.push({ type: 'stdout', text: trimmed, time: Date.now() });
                appendAgentLog(taskId, `[STDOUT] ${trimmed}`);
            }
        }
    }

    return remainingBuffer;
}

// GET /api/beads/agents - List all running agents
app.get('/api/beads/agents', (req, res) => {
    const agents = [];

    for (const [taskId, data] of runningAgents.entries()) {
        agents.push({
            taskId,
            title: data.task?.title || 'Unknown',
            supervisorType: data.supervisorType || 'worker',
            branchName: data.branchName,
            status: data.status,
            startTime: data.startTime,
            runningFor: Date.now() - data.startTime,
            outputLines: data.outputBuffer.length,
            exitCode: data.exitCode
        });
    }

    res.json({ agents });
});

// GET /api/orchestrator/logs/:taskId - Get agent log file (TASK-319)
app.get('/api/orchestrator/logs/:taskId', (req, res) => {
    const taskId = req.params.taskId;
    const logFile = path.join(logsDir, `agent-${taskId}.log`);

    if (!fs.existsSync(logFile)) {
        return res.status(404).json({ error: 'Log file not found', taskId });
    }

    try {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        res.json({
            taskId,
            logFile,
            lineCount: lines.length,
            content: lines.slice(-100) // Last 100 lines
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/beads/merge/:id - Merge agent's branch to main
app.post('/api/beads/merge/:id', (req, res) => {
    const taskId = req.params.id;
    const projectRoot = path.join(__dirname, '..');
    const branchName = `bd-${taskId}`;

    try {
        // Check we're on main
        const currentBranch = execSync('git branch --show-current', {
            cwd: projectRoot,
            encoding: 'utf8'
        }).trim();

        if (currentBranch !== 'main' && currentBranch !== 'master') {
            // Switch to main
            execSync('git checkout main || git checkout master', {
                cwd: projectRoot,
                encoding: 'utf8',
                shell: true
            });
        }

        // Merge the branch
        execSync(`git merge ${branchName} --no-ff -m "Merge ${branchName}: Task completed"`, {
            cwd: projectRoot,
            encoding: 'utf8'
        });

        // Clean up worktree
        cleanupWorktree(taskId);

        // Delete the branch
        try {
            execSync(`git branch -d ${branchName}`, {
                cwd: projectRoot,
                encoding: 'utf8'
            });
        } catch (e) {
            console.log(`[Agent] Could not delete branch ${branchName}: ${e.message}`);
        }

        // Close the bead
        execSync(`${BD_PATH} close ${taskId} --reason "Merged to main"`, {
            cwd: projectRoot,
            encoding: 'utf8'
        });

        res.json({ success: true, message: `Merged ${branchName} to main and closed bead` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/beads/agents/:id/stream - SSE stream for agent output
app.get('/api/beads/agents/:id/stream', (req, res) => {
    const taskId = req.params.id;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send existing output buffer first
    const agentData = runningAgents.get(taskId);
    if (agentData) {
        for (const entry of agentData.outputBuffer) {
            res.write(`data: ${JSON.stringify({ taskId, ...entry })}\n\n`);
        }

        // If agent already finished, send exit event
        if (agentData.status !== 'running') {
            res.write(`data: ${JSON.stringify({
                taskId,
                type: 'exit',
                code: agentData.exitCode,
                status: agentData.status
            })}\n\n`);
        }
    }

    // Add to clients list for live updates
    if (!agentOutputClients.has(taskId)) {
        agentOutputClients.set(taskId, []);
    }
    agentOutputClients.get(taskId).push(res);

    console.log(`[Agent] SSE client connected for task ${taskId}`);

    // Keep alive
    const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
    }, 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        const clients = agentOutputClients.get(taskId) || [];
        agentOutputClients.set(taskId, clients.filter(c => c !== res));
        console.log(`[Agent] SSE client disconnected for task ${taskId}`);
    });
});

// POST /api/beads/agents/:id/stop - Stop a running agent
app.post('/api/beads/agents/:id/stop', (req, res) => {
    const taskId = req.params.id;
    const agentData = runningAgents.get(taskId);

    if (!agentData) {
        return res.status(404).json({ error: 'No agent running for this task' });
    }

    if (agentData.status !== 'running') {
        return res.json({ success: true, message: 'Agent already stopped' });
    }

    try {
        agentData.process.kill('SIGTERM');
        agentData.status = 'stopped';

        // Also update beads status back to ready
        execSync(`${BD_PATH} update ${taskId} --status todo`, {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8'
        });

        res.json({ success: true, message: 'Agent stopped' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/beads/agents/:id/command - Send a command to an agent (spawns follow-up)
app.post('/api/beads/agents/:id/command', (req, res) => {
    const taskId = req.params.id;
    const { command } = req.body;
    const agentData = runningAgents.get(taskId);

    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }

    // Build context from previous output
    const recentOutput = agentData?.outputBuffer?.slice(-20).map(o => o.text).join('') || '';

    // Broadcast the user command to the UI
    broadcastAgentOutput(taskId, {
        type: 'user',
        text: `> ${command}`
    });

    console.log(`[Agent] Sending command to ${taskId}: ${command.slice(0, 50)}...`);

    // Spawn a new claude process with the command as context
    const prompt = `You are continuing work on Beads task: ${taskId}

${agentData?.task?.title ? `Task: ${agentData.task.title}` : ''}

The user has sent you this instruction:
${command}

Recent context from previous work:
${recentOutput.slice(-2000)}

Execute the user's instruction now.`;

    const followUpProcess = spawn(CLAUDE_BINARY, [
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '-p', prompt
    ], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    // If there was a previous process, update reference
    if (agentData) {
        // Keep the old process running if it exists
        agentData.commandCount = (agentData.commandCount || 0) + 1;
    }

    // Track this follow-up process - use command as descriptive title
    const commandTitle = command.length > 50 ? command.slice(0, 50) + '...' : command;
    const followUpData = agentData || {
        task: {
            title: commandTitle,
            originalCommand: command
        },
        taskId: taskId,
        startTime: Date.now(),
        outputBuffer: [],
        status: 'running'
    };

    followUpData.process = followUpProcess;
    followUpData.status = 'running';
    followUpData.jsonBuffer = ''; // Buffer for JSON parsing
    runningAgents.set(taskId, followUpData);

    followUpProcess.stdout.on('data', (data) => {
        // Use shared parsing function to filter noise
        followUpData.jsonBuffer = parseAndBroadcastAgentOutput(
            taskId,
            data.toString(),
            followUpData,
            followUpData.jsonBuffer
        );
    });

    followUpProcess.stderr.on('data', (data) => {
        const output = data.toString();
        followUpData.outputBuffer.push({ type: 'stderr', text: output, time: Date.now() });
        broadcastAgentOutput(taskId, { type: 'stderr', text: output });
    });

    followUpProcess.on('close', (code) => {
        console.log(`[Agent] Follow-up for ${taskId} exited with code ${code}`);
        followUpData.status = code === 0 ? 'idle' : 'failed';
        followUpData.exitCode = code;
        broadcastAgentOutput(taskId, {
            type: 'status',
            status: 'idle',
            message: 'Ready for next command'
        });
    });

    followUpProcess.on('error', (err) => {
        console.error(`[Agent] Follow-up error for ${taskId}:`, err.message);
        broadcastAgentOutput(taskId, { type: 'error', message: err.message });
    });

    res.json({ success: true, message: 'Command sent' });
});

// POST /api/beads/close/:id - Close a task
app.post('/api/beads/close/:id', (req, res) => {
    const { reason } = req.body;
    try {
        execSync(`${BD_PATH} close ${req.params.id} --reason "${reason || 'Completed'}"`, {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8'
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============== ORCHESTRATOR API ==============
// Full agentic orchestration system that:
// 1. Understands requirements through natural language + clarifying questions
// 2. Creates specialized sub-agents for different parts
// 3. Monitors and auto-retries failed agents
// 4. Provides summary progress updates
// 5. Conducts review sessions with user

// Track orchestrations
const orchestrations = new Map(); // orchestrationId -> OrchestratorState

// Load orchestrations from disk on startup
function loadOrchestrations() {
    try {
        if (fs.existsSync(ORCHESTRATIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ORCHESTRATIONS_FILE, 'utf8'));
            for (const [id, orch] of Object.entries(data)) {
                // Don't restore process references - they're not serializable
                orch.subAgents = orch.subAgents?.map(a => ({ ...a, process: null })) || [];
                orchestrations.set(id, orch);
            }
            console.log(`[Orchestrator] Loaded ${orchestrations.size} orchestrations from disk`);
        }
    } catch (err) {
        console.error('[Orchestrator] Failed to load orchestrations:', err.message);
    }
}

// Save orchestrations to disk
function saveOrchestrations() {
    try {
        // Ensure data directory exists
        const dataDir = path.dirname(ORCHESTRATIONS_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // Convert Map to object, excluding non-serializable properties
        const data = {};
        for (const [id, orch] of orchestrations) {
            data[id] = {
                ...orch,
                subAgents: orch.subAgents?.map(a => ({
                    ...a,
                    process: undefined  // Can't serialize process
                })) || []
            };
        }

        fs.writeFileSync(ORCHESTRATIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('[Orchestrator] Failed to save orchestrations:', err.message);
    }
}

// Debounced save to avoid excessive disk writes
let saveTimeout = null;
function debouncedSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveOrchestrations, 1000);
}

// Load on startup
loadOrchestrations();

// Orchestrator state machine
class OrchestratorState {
    constructor(id, goal) {
        this.id = id;
        this.goal = goal;
        this.phase = 'requirements'; // requirements | planning | execution | review
        this.questions = [];        // Clarifying questions to ask
        this.answers = {};          // User's answers
        this.plan = [];             // Breakdown of tasks
        this.subAgents = [];        // Spawned agents { taskId, status, retries, output }
        this.summary = [];          // Progress summaries
        this.startTime = Date.now();
        this.status = 'active';
        this.maxRetries = 3;
    }
}

// SSE clients for orchestrator updates
const orchestratorClients = new Map(); // orchestrationId -> [res, res, ...]

// Helper to broadcast orchestrator updates
function broadcastOrchestration(orchId, data) {
    const clients = orchestratorClients.get(orchId) || [];
    const payload = JSON.stringify({ orchestrationId: orchId, ...data, timestamp: Date.now() });

    clients.forEach(client => {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (e) {
            // Client disconnected
        }
    });

    // Also store in orchestration state for history
    const orch = orchestrations.get(orchId);
    if (orch && data.type === 'summary') {
        orch.summary.push({ ...data, timestamp: Date.now() });
    }
}

// POST /api/orchestrator/start - Start a new orchestration with a goal
app.post('/api/orchestrator/start', (req, res) => {
    const { goal } = req.body;

    if (!goal) {
        return res.status(400).json({ error: 'Goal is required' });
    }

    const orchId = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orch = new OrchestratorState(orchId, goal);
    orchestrations.set(orchId, orch);
    debouncedSave();

    console.log(`[Orchestrator] Started ${orchId}: "${goal.slice(0, 50)}..."`);

    // Phase 1: Generate clarifying questions using Claude
    generateClarifyingQuestions(orch);

    res.json({
        success: true,
        orchestrationId: orchId,
        phase: 'requirements',
        message: 'Orchestration started. Generating clarifying questions...'
    });
});

// GET /api/orchestrator/list - List all orchestrations (MUST be before /:id routes!)
app.get('/api/orchestrator/list', (req, res) => {
    const list = [];

    for (const [id, orch] of orchestrations.entries()) {
        list.push({
            id,
            goal: orch.goal.slice(0, 100),
            phase: orch.phase,
            status: orch.status,
            taskCount: orch.plan.length,
            completedTasks: orch.subAgents.filter(a => a.status === 'completed').length,
            startTime: orch.startTime,
            runtime: Date.now() - orch.startTime
        });
    }

    res.json({ orchestrations: list });
});

// Helper: Detect tech stack from package.json
function detectTechStack() {
    try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            const stack = [];

            if (deps['vue'] || deps['@vue/cli-service']) stack.push('Vue 3');
            if (deps['react'] || deps['react-dom']) stack.push('React');
            if (deps['typescript']) stack.push('TypeScript');
            if (deps['vite']) stack.push('Vite');
            if (deps['tailwindcss']) stack.push('Tailwind CSS');
            if (deps['pinia']) stack.push('Pinia');
            if (deps['@supabase/supabase-js']) stack.push('Supabase');
            if (deps['@vue-flow/core']) stack.push('Vue Flow');
            if (deps['naive-ui']) stack.push('Naive UI');
            if (deps['@tiptap/vue-3']) stack.push('TipTap');

            return stack.length > 0 ? stack.join(', ') : 'Unknown';
        }
    } catch (e) {
        console.error('[Orchestrator] Error detecting tech stack:', e.message);
    }
    return 'Unknown';
}

// Helper: Use fallback questions when Claude fails or times out
function useFallbackQuestions(orch, reason) {
    console.log(`[Orchestrator] Using fallback questions (reason: ${reason})`);

    // Auto-detect tech stack
    const detectedStack = detectTechStack();
    console.log(`[Orchestrator] Detected tech stack: ${detectedStack}`);

    orch.questions = [
        {
            id: 'q0',
            question: `Detected tech stack: ${detectedStack}. Is this correct?`,
            type: 'choice',
            multiSelect: false,
            options: ['Yes, use this stack', 'No, let me specify']
        },
        {
            id: 'q1',
            question: 'What type of feature is this?',
            type: 'choice',
            multiSelect: false,
            options: ['New feature', 'Bug fix', 'Refactoring', 'Performance improvement', 'UI/UX update']
        },
        {
            id: 'q2',
            question: 'What is the scope of this work?',
            type: 'choice',
            multiSelect: false,
            options: ['Small (1-2 files)', 'Medium (3-5 files)', 'Large (6+ files)', 'Not sure']
        },
        {
            id: 'q3',
            question: 'What are the essential features or requirements? (describe briefly)',
            type: 'text',
            multiSelect: false
        },
        {
            id: 'q4',
            question: 'What quality and testing requirements apply?',
            type: 'multiselect',
            multiSelect: true,
            options: ['Unit tests required', 'E2E tests required', 'Keep backwards compatible', 'Performance critical', 'Accessibility compliance']
        }
    ];

    broadcastOrchestration(orch.id, {
        type: 'questions',
        questions: orch.questions,
        message: 'A few questions to clarify requirements:'
    });
    debouncedSave();
}

// Helper: Detect project tech stack from package.json and codebase
function detectProjectContext(projectPath) {
    const context = {
        framework: null,
        uiLibrary: null,
        stateManagement: null,
        database: null,
        testing: [],
        buildTool: null,
        components: [],
        rawDeps: {}
    };

    try {
        // Read package.json
        const pkgPath = path.join(projectPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            context.rawDeps = deps;

            // Detect framework
            if (deps['vue'] || deps['vue-router']) context.framework = 'Vue 3';
            else if (deps['react'] || deps['react-dom']) context.framework = 'React';
            else if (deps['svelte']) context.framework = 'Svelte';
            else if (deps['@angular/core']) context.framework = 'Angular';

            // Detect UI library
            if (deps['naive-ui']) context.uiLibrary = 'Naive UI';
            else if (deps['@mui/material']) context.uiLibrary = 'Material UI';
            else if (deps['@chakra-ui/react']) context.uiLibrary = 'Chakra UI';
            else if (deps['vuetify']) context.uiLibrary = 'Vuetify';
            else if (deps['element-plus']) context.uiLibrary = 'Element Plus';
            else if (deps['ant-design-vue'] || deps['antd']) context.uiLibrary = 'Ant Design';

            // Detect state management
            if (deps['pinia']) context.stateManagement = 'Pinia';
            else if (deps['vuex']) context.stateManagement = 'Vuex';
            else if (deps['redux'] || deps['@reduxjs/toolkit']) context.stateManagement = 'Redux';
            else if (deps['zustand']) context.stateManagement = 'Zustand';
            else if (deps['mobx']) context.stateManagement = 'MobX';

            // Detect database/backend
            if (deps['@supabase/supabase-js']) context.database = 'Supabase';
            else if (deps['firebase']) context.database = 'Firebase';
            else if (deps['prisma'] || deps['@prisma/client']) context.database = 'Prisma';

            // Detect testing
            if (deps['vitest']) context.testing.push('Vitest');
            if (deps['jest']) context.testing.push('Jest');
            if (deps['@playwright/test'] || deps['playwright']) context.testing.push('Playwright');
            if (deps['cypress']) context.testing.push('Cypress');

            // Detect build tool
            if (deps['vite']) context.buildTool = 'Vite';
            else if (deps['webpack']) context.buildTool = 'Webpack';
            else if (deps['esbuild']) context.buildTool = 'esbuild';

            // Detect common components/libraries
            if (deps['@vueflow/core'] || deps['vue-flow']) context.components.push('Vue Flow (canvas)');
            if (deps['@tiptap/vue-3'] || deps['tiptap']) context.components.push('TipTap (rich text editor)');
            if (deps['vuedraggable']) context.components.push('Vue Draggable');
            if (deps['tailwindcss']) context.components.push('Tailwind CSS');
        }

        // Check for existing modals/components
        const srcPath = path.join(projectPath, 'src');
        if (fs.existsSync(srcPath)) {
            const checkPaths = [
                { pattern: 'components/**/Modal*.vue', name: 'Custom modals' },
                { pattern: 'components/**/Dialog*.vue', name: 'Custom dialogs' },
                { pattern: 'composables/use*.ts', name: 'Custom composables' }
            ];

            // Simple check for common component patterns
            try {
                const componentsPath = path.join(srcPath, 'components');
                if (fs.existsSync(componentsPath)) {
                    const files = fs.readdirSync(componentsPath, { recursive: true });
                    const hasModals = files.some(f => f.toString().toLowerCase().includes('modal'));
                    const hasDialogs = files.some(f => f.toString().toLowerCase().includes('dialog'));
                    if (hasModals || hasDialogs) context.components.push('Custom modal/dialog components');
                }
            } catch (e) { /* ignore */ }
        }

    } catch (err) {
        console.error('[Orchestrator] Error detecting project context:', err.message);
    }

    return context;
}

// Helper: Generate clarifying questions based on goal
async function generateClarifyingQuestions(orch) {
    console.log(`[Orchestrator] generateClarifyingQuestions called for ${orch.id}`);

    // TEMPORARY: Skip Claude and use fallback questions for faster testing
    // TODO: Re-enable Claude once we debug the hanging issue
    const USE_CLAUDE_FOR_QUESTIONS = true;

    if (!USE_CLAUDE_FOR_QUESTIONS) {
        console.log(`[Orchestrator] Using immediate fallback questions (Claude disabled)`);
        setTimeout(() => useFallbackQuestions(orch, 'claude_disabled'), 500);
        return;
    }

    // Auto-detect project context
    const projectPath = path.join(__dirname, '..');
    const detectedContext = detectProjectContext(projectPath);
    orch.detectedContext = detectedContext; // Store for later use

    console.log('[Orchestrator] Detected project context:', JSON.stringify(detectedContext, null, 2));

    // Build context string for prompt
    const contextLines = [];
    if (detectedContext.framework) contextLines.push(`- Framework: ${detectedContext.framework}`);
    if (detectedContext.uiLibrary) contextLines.push(`- UI Library: ${detectedContext.uiLibrary} (has modal/dialog components)`);
    if (detectedContext.stateManagement) contextLines.push(`- State Management: ${detectedContext.stateManagement}`);
    if (detectedContext.database) contextLines.push(`- Database/Backend: ${detectedContext.database}`);
    if (detectedContext.testing.length) contextLines.push(`- Testing: ${detectedContext.testing.join(', ')}`);
    if (detectedContext.buildTool) contextLines.push(`- Build Tool: ${detectedContext.buildTool}`);
    if (detectedContext.components.length) contextLines.push(`- Components: ${detectedContext.components.join(', ')}`);

    const contextBlock = contextLines.length > 0
        ? `\n\n**DETECTED PROJECT CONTEXT (DO NOT ASK ABOUT THESE - ALREADY KNOWN):**\n${contextLines.join('\n')}\n`
        : '';

    const prompt = `You are an expert requirements analyst. The user wants to build:

"${orch.goal}"
${contextBlock}
Generate 2-4 clarifying questions to understand their requirements better.

**CRITICAL RULES:**
1. DO NOT ask about framework, UI library, state management, database, or build tools - these are already detected above
2. DO NOT ask generic questions like "What framework?" or "Do you have a modal system?" - CHECK THE DETECTED CONTEXT
3. ONLY ask about things NOT listed in the detected context
4. Focus on the SPECIFIC FEATURE they want to build, not the tech stack

Focus on:
1. Implementation details specific to the feature (where exactly should this appear, what triggers it)
2. User experience (animations, transitions, behavior on cancel/save)
3. Edge cases (what if user is mid-edit, what about unsaved changes)
4. Integration with existing features (should this work with existing task system, etc.)

Output ONLY a JSON array of questions, each with:
- "id": unique string (e.g., "q1", "q2")
- "question": the question text
- "options": optional array of common answers (2-5 options)
- "type": "choice", "multiselect", or "text"
- "multiSelect": boolean (true for questions where multiple options can be selected)

Example for a "long press to edit" feature:
[
  {"id": "q1", "question": "What should the long-press duration be?", "options": ["300ms (quick)", "500ms (standard)", "800ms (deliberate)"], "type": "choice", "multiSelect": false},
  {"id": "q2", "question": "Should there be visual feedback during the long press?", "options": ["Progress ring animation", "Subtle scale/pulse", "Haptic feedback only", "No feedback needed"], "type": "choice", "multiSelect": false},
  {"id": "q3", "question": "What happens if user is offline during edit?", "options": ["Queue changes for sync", "Show warning but allow edit", "Block editing until online"], "type": "choice", "multiSelect": false}
]`;

    broadcastOrchestration(orch.id, {
        type: 'phase',
        phase: 'requirements',
        message: 'Analyzing your goal and generating clarifying questions...'
    });

    try {
        // Spawn Claude to generate questions
        // Use 'pipe' for stdin and close it immediately to prevent hanging
        const questionProcess = spawn(CLAUDE_BINARY, [
            '--print',
            '-p', prompt
        ], {
            cwd: path.join(__dirname, '..'),
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        // Close stdin immediately - Claude --print doesn't need input
        questionProcess.stdin.end();

        let output = '';
        let stderr = '';
        let timedOut = false;

        // Set timeout to prevent infinite hang (30 seconds)
        const timeout = setTimeout(() => {
            timedOut = true;
            console.log('[Orchestrator] Claude process timed out after 30s, using fallback questions');
            questionProcess.kill('SIGTERM');
        }, 30000);

        questionProcess.stdout.on('data', (data) => {
            output += data.toString();
            console.log(`[Orchestrator] Claude stdout chunk: ${data.toString().substring(0, 100)}...`);
        });

        questionProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log(`[Orchestrator] Claude stderr: ${data.toString()}`);
        });

        questionProcess.on('close', (code) => {
            clearTimeout(timeout);

            if (timedOut) {
                // Already handled by timeout
                useFallbackQuestions(orch, 'timeout');
                return;
            }
            if (code === 0) {
                try {
                    // Extract JSON from output (may have extra text)
                    const jsonMatch = output.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const questions = JSON.parse(jsonMatch[0]);
                        orch.questions = questions;

                        broadcastOrchestration(orch.id, {
                            type: 'questions',
                            questions: questions,
                            message: 'Please answer these questions to help me understand your requirements:'
                        });
                        debouncedSave();
                    } else {
                        throw new Error('No JSON array found in output');
                    }
                } catch (e) {
                    console.error(`[Orchestrator] Error parsing questions: ${e.message}`);
                    console.error(`[Orchestrator] Raw output was: ${output.substring(0, 500)}`);
                    useFallbackQuestions(orch, 'parse_error');
                }
            } else {
                console.error(`[Orchestrator] Claude exited with code ${code}, stderr: ${stderr}`);
                useFallbackQuestions(orch, `exit_code_${code}`);
            }
        });

        questionProcess.on('error', (err) => {
            console.error(`[Orchestrator] Error spawning Claude: ${err.message}`);
            useFallbackQuestions(orch, 'spawn_error');
        });

    } catch (err) {
        console.error(`[Orchestrator] Error generating questions: ${err.message}`);
        useFallbackQuestions(orch, 'exception');
    }
}

// POST /api/orchestrator/:id/answer - Submit answers to clarifying questions
app.post('/api/orchestrator/:id/answer', async (req, res) => {
    const orchId = req.params.id;
    const { answers } = req.body;

    const orch = orchestrations.get(orchId);
    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    // Store answers
    orch.answers = { ...orch.answers, ...answers };
    debouncedSave();

    console.log('[Orchestrator] Received answers:', JSON.stringify(answers, null, 2));

    // TEMPORARY: Skip clarification check and proceed directly to planning
    // TODO: Re-enable when Claude follow-up generation is fixed
    const SKIP_CLARIFICATION = true;

    if (!SKIP_CLARIFICATION) {
        // Check if any answers need follow-up clarification
        const needsClarification = checkAnswersNeedClarification(answers, orch.questions);

        if (needsClarification.length > 0) {
            // Generate follow-up questions for unclear answers
            broadcastOrchestration(orch.id, {
                type: 'phase',
                phase: 'questions',
                message: 'Some answers need clarification. Generating follow-up questions...'
            });

            generateFollowUpQuestions(orch, needsClarification);

            res.json({
                success: true,
                phase: 'questions',
                message: 'Generating follow-up questions for clarification...'
            });
            return;
        }
    }

    // All answers are clear (or clarification skipped), move to planning phase
    orch.phase = 'planning';
    debouncedSave();

    broadcastOrchestration(orch.id, {
        type: 'phase',
        phase: 'planning',
        message: 'Answers received. Creating implementation plan...'
    });

    // Generate plan based on goal + answers
    generatePlan(orch);

    res.json({
        success: true,
        phase: 'planning',
        message: 'Moving to planning phase...'
    });
});

// Check if answers need follow-up clarification
function checkAnswersNeedClarification(answers, questions) {
    const needsClarification = [];

    // Phrases that indicate the user wants to discuss/clarify further
    const clarificationIndicators = [
        'need to discuss',
        'need to go over',
        'need to decide',
        'not sure',
        'depends on',
        'let\'s talk about',
        'want to explore',
        'more information',
        'clarify',
        'options',
        'alternatives',
        'what do you think',
        'your recommendation',
        'help me decide',
        'pros and cons',
        'trade-offs',
        'compare'
    ];

    for (const [questionId, answer] of Object.entries(answers)) {
        if (typeof answer !== 'string') continue;

        const lowerAnswer = answer.toLowerCase();
        const needsFollowUp = clarificationIndicators.some(phrase =>
            lowerAnswer.includes(phrase)
        );

        if (needsFollowUp) {
            const question = questions.find(q => q.id === questionId);
            needsClarification.push({
                questionId,
                question: question?.question || questionId,
                answer
            });
        }
    }

    return needsClarification;
}

// Generate follow-up questions for unclear answers
function generateFollowUpQuestions(orch, unclearAnswers) {
    const unclearContext = unclearAnswers.map(u =>
        `Original Question: ${u.question}\nUser's Response: "${u.answer}"`
    ).join('\n\n');

    const prompt = `You are a requirements analyst helping clarify project requirements.

PROJECT GOAL: "${orch.goal}"

The user gave responses that need clarification:

${unclearContext}

The user seems to want guidance or discussion before deciding. Generate 2-3 specific follow-up questions that will help them make a decision. For each question:
- Be specific and actionable
- Offer concrete options when possible
- Help them understand the trade-offs

Output ONLY a JSON array of questions:
[{"id": "followup-1", "question": "...", "type": "choice", "options": ["Option A", "Option B", "Option C"]}]

Use type "choice" with options when there are clear alternatives, or "text" for open-ended.`;

    try {
        const followUpProcess = spawn(CLAUDE_BINARY, ['--print', '-p', prompt], {
            cwd: path.join(__dirname, '..'),
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env, ANTHROPIC_API_KEY: '' }
        });

        let output = '';
        followUpProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        followUpProcess.stderr.on('data', (data) => {
            console.log('[Orchestrator] Follow-up stderr:', data.toString());
        });

        followUpProcess.on('close', (code) => {
            if (code === 0) {
                try {
                    const jsonMatch = output.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const newQuestions = JSON.parse(jsonMatch[0]);
                        // Add follow-up questions to the list
                        orch.questions.push(...newQuestions);
                        debouncedSave();

                        broadcastOrchestration(orch.id, {
                            type: 'questions',
                            questions: orch.questions,
                            message: 'I have some follow-up questions to help clarify your requirements:'
                        });
                    }
                } catch (e) {
                    console.error('[Orchestrator] Error parsing follow-up questions:', e.message);
                }
            }
        });

        followUpProcess.on('error', (err) => {
            console.error('[Orchestrator] Error spawning follow-up process:', err.message);
        });
    } catch (err) {
        console.error('[Orchestrator] Error generating follow-up questions:', err.message);
    }
}

// Helper: Use fallback plan when Claude fails
function useFallbackPlan(orch) {
    console.log('[Orchestrator] Using fallback plan');

    // Generate a basic plan based on the goal
    const goalLower = orch.goal.toLowerCase();
    let tasks = [];

    if (goalLower.includes('pwa') || goalLower.includes('progressive')) {
        tasks = [
            { id: 'task-1', title: 'Configure PWA manifest', description: 'Set up manifest.json with app name, icons, and display settings', agentType: 'frontend', dependencies: [], priority: 'P1' },
            { id: 'task-2', title: 'Implement service worker', description: 'Create service worker for offline caching and background sync', agentType: 'frontend', dependencies: ['task-1'], priority: 'P1' },
            { id: 'task-3', title: 'Add install prompt', description: 'Implement "Add to Home Screen" prompt for mobile users', agentType: 'frontend', dependencies: ['task-2'], priority: 'P2' },
            { id: 'task-4', title: 'Optimize for offline', description: 'Ensure critical features work offline with local storage fallback', agentType: 'frontend', dependencies: ['task-2'], priority: 'P2' },
            { id: 'task-5', title: 'Test PWA functionality', description: 'Verify Lighthouse PWA audit passes and test on multiple devices', agentType: 'qa', dependencies: ['task-3', 'task-4'], priority: 'P2' }
        ];
    } else {
        // Generic feature tasks
        tasks = [
            { id: 'task-1', title: 'Research & Design', description: 'Analyze requirements and design the solution architecture', agentType: 'frontend', dependencies: [], priority: 'P1' },
            { id: 'task-2', title: 'Implement core feature', description: 'Build the main functionality as described in the goal', agentType: 'frontend', dependencies: ['task-1'], priority: 'P1' },
            { id: 'task-3', title: 'Add UI components', description: 'Create necessary UI components and styling', agentType: 'frontend', dependencies: ['task-2'], priority: 'P2' },
            { id: 'task-4', title: 'Integration & Testing', description: 'Integrate with existing systems and write tests', agentType: 'qa', dependencies: ['task-3'], priority: 'P2' },
            { id: 'task-5', title: 'Documentation', description: 'Document the new feature and update relevant docs', agentType: 'docs', dependencies: ['task-4'], priority: 'P3' }
        ];
    }

    orch.plan = tasks;
    orch.phase = 'plan';
    orch.planGenerating = false;
    debouncedSave();

    broadcastOrchestration(orch.id, {
        type: 'plan',
        plan: tasks,
        message: 'Implementation plan ready for review:'
    });
}

// Helper: Generate implementation plan
async function generatePlan(orch) {
    console.log('[Orchestrator] generatePlan called for:', orch.id);

    // TEMPORARY: Skip Claude and use fallback plan for faster testing
    const USE_CLAUDE_FOR_PLAN = true;

    if (!USE_CLAUDE_FOR_PLAN) {
        console.log('[Orchestrator] Using immediate fallback plan (Claude disabled)');
        setTimeout(() => useFallbackPlan(orch), 500);
        return;
    }

    const answersText = Object.entries(orch.answers)
        .map(([key, val]) => {
            const question = orch.questions.find(q => q.id === key);
            return `Q: ${question?.question || key}\nA: ${val}`;
        })
        .join('\n\n');

    const prompt = `You are an expert software architect. Create an implementation plan for:

GOAL: "${orch.goal}"

USER REQUIREMENTS:
${answersText}

Create a detailed plan broken into tasks. Each task should be:
- Specific and actionable
- Assignable to a specialized agent type (backend, frontend, devops, qa, docs)
- Small enough to complete in one session

Output ONLY a JSON array of tasks:
[
  {
    "id": "task-1",
    "title": "Set up project structure",
    "description": "Initialize the project with Vite + Vue 3 + TypeScript",
    "agentType": "frontend",
    "dependencies": [],
    "priority": "P1"
  },
  {
    "id": "task-2",
    "title": "Create database schema",
    "description": "Design and implement the PostgreSQL schema for user data",
    "agentType": "backend",
    "dependencies": ["task-1"],
    "priority": "P1"
  }
]

Create 5-10 tasks that cover the full implementation.`;

    // Prevent duplicate plan generation
    if (orch.planGenerating) {
        console.log('[Orchestrator] Plan already generating, skipping duplicate call');
        return;
    }
    orch.planGenerating = true;

    broadcastOrchestration(orch.id, {
        type: 'progress',
        message: 'Analyzing requirements and creating task breakdown...'
    });

    console.log('[Orchestrator] Generating plan for:', orch.id);
    console.log('[Orchestrator] Prompt length:', prompt.length);

    try {
        const planProcess = spawn(CLAUDE_BINARY, [
            '--print',
            '-p', prompt
        ], {
            cwd: path.join(__dirname, '..'),
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        // Close stdin immediately - Claude --print doesn't need input
        planProcess.stdin.end();

        console.log('[Orchestrator] Claude process spawned for plan generation');

        let output = '';
        let timedOut = false;

        // Set timeout to prevent infinite hang (60 seconds for plan generation)
        const timeout = setTimeout(() => {
            timedOut = true;
            console.log('[Orchestrator] Plan generation timed out after 60s, using fallback');
            planProcess.kill('SIGTERM');
            orch.planGenerating = false;
            useFallbackPlan(orch);
        }, 60000);

        planProcess.stdout.on('data', (data) => {
            output += data.toString();
            console.log(`[Orchestrator] Plan stdout chunk: ${data.toString().substring(0, 100)}...`);
        });

        planProcess.stderr.on('data', (data) => {
            console.log(`[Orchestrator] Plan stderr: ${data.toString()}`);
        });

        planProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (timedOut) return;  // Already handled by timeout

            orch.planGenerating = false;  // Reset flag

            if (code === 0) {
                try {
                    const jsonMatch = output.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const plan = JSON.parse(jsonMatch[0]);
                        orch.plan = plan;
                        debouncedSave();

                        broadcastOrchestration(orch.id, {
                            type: 'plan',
                            plan: plan,
                            message: `Created ${plan.length} tasks. Ready to start execution.`
                        });

                        // Auto-move to execution if plan looks good
                        // User can review and modify first
                    } else {
                        throw new Error('No JSON array found');
                    }
                } catch (e) {
                    console.error(`[Orchestrator] Error parsing plan: ${e.message}`);
                    broadcastOrchestration(orch.id, {
                        type: 'error',
                        message: 'Failed to generate plan. Please try again.'
                    });
                }
            } else {
                console.error(`[Orchestrator] Plan generation failed with code ${code}`);
                broadcastOrchestration(orch.id, {
                    type: 'error',
                    message: 'Plan generation failed. Please try again.'
                });
            }
        });

    } catch (err) {
        console.error(`[Orchestrator] Error generating plan: ${err.message}`);
    }
}

// POST /api/orchestrator/:id/execute - Start executing the plan
app.post('/api/orchestrator/:id/execute', (req, res) => {
    const orchId = req.params.id;
    const orch = orchestrations.get(orchId);

    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    if (!orch.plan || orch.plan.length === 0) {
        return res.status(400).json({ error: 'No plan to execute' });
    }

    orch.phase = 'execution';
    debouncedSave();

    broadcastOrchestration(orch.id, {
        type: 'phase',
        phase: 'execution',
        message: 'Starting execution. Spawning agents for tasks...'
    });

    // Start executing tasks (respecting dependencies)
    executeNextTasks(orch);

    res.json({
        success: true,
        phase: 'execution',
        message: 'Execution started'
    });
});

// Helper: Get orchestration execution stats
function getOrchestrationStats(orch) {
    const completed = orch.subAgents.filter(a => a.status === 'completed').length;
    const running = orch.subAgents.filter(a => a.status === 'running').length;
    const failed = orch.subAgents.filter(a => a.status === 'failed').length;
    const pending = orch.plan.length - orch.subAgents.length;
    return { completed, running, failed, pending, total: orch.plan.length };
}

// Helper: Execute next available tasks
function executeNextTasks(orch) {
    // Find tasks that are ready (dependencies completed)
    const completedIds = orch.subAgents
        .filter(a => a.status === 'completed')
        .map(a => a.taskId);

    const runningIds = orch.subAgents
        .filter(a => a.status === 'running')
        .map(a => a.taskId);

    const readyTasks = orch.plan.filter(task => {
        // Not already started
        if (orch.subAgents.some(a => a.taskId === task.id)) return false;
        // Dependencies met
        const deps = task.dependencies || [];
        return deps.every(dep => completedIds.includes(dep));
    });

    // Limit concurrent agents to 3
    const availableSlots = 3 - runningIds.length;
    const tasksToStart = readyTasks.slice(0, availableSlots);

    for (const task of tasksToStart) {
        spawnSubAgent(orch, task);
    }

    // Check if all done
    if (runningIds.length === 0 && readyTasks.length === 0) {
        const allCompleted = orch.plan.every(t =>
            orch.subAgents.some(a => a.taskId === t.id && a.status === 'completed')
        );

        if (allCompleted) {
            orch.phase = 'review';
            debouncedSave();
            broadcastOrchestration(orch.id, {
                type: 'phase',
                phase: 'review',
                message: 'All tasks completed! Ready for review.'
            });
        }
    }
}

// Helper: Spawn a sub-agent for a task
function spawnSubAgent(orch, task) {
    // Create isolated worktree for this agent
    const worktreeTaskId = `orch-${task.id}`;
    const { worktreePath, branchName, created } = createAgentWorktree(worktreeTaskId);

    console.log(`[Orchestrator] Agent worktree: ${worktreePath} (branch: ${branchName}, created: ${created})`);

    const subAgentData = {
        taskId: task.id,
        task: task,
        status: 'running',
        retries: 0,
        output: [],
        startTime: Date.now(),
        worktreePath: worktreePath,
        branchName: branchName
    };

    orch.subAgents.push(subAgentData);

    // Broadcast task_started event with stats
    const stats = getOrchestrationStats(orch);
    broadcastOrchestration(orch.id, {
        type: 'task_started',
        taskId: task.id,
        task: task,
        worktree: worktreePath,
        branch: branchName,
        stats: stats,
        message: `🚀 Starting: ${task.title} (${task.agentType})`
    });

    // Build prompt for this specific task
    const prompt = `You are a ${task.agentType} specialist working on a larger project.

PROJECT GOAL: ${orch.goal}

YOUR TASK: ${task.title}
${task.description}

REQUIREMENTS FROM USER:
${Object.entries(orch.answers).map(([k, v]) => `- ${v}`).join('\n')}

Instructions:
1. Complete this specific task thoroughly
2. Test your work by running relevant tests or verifying manually
3. Commit your changes with a clear message
4. Report what you accomplished

Focus only on this task. Other tasks are being handled by other specialists.
You are working in an isolated git worktree. Your changes will be reviewed before merging.`;

    console.log(`[Orchestrator] Spawning Claude agent for task ${task.id} in ${worktreePath}`);

    // TASK-319: Add stream-json output format for proper parsing
    const agentProcess = spawn(CLAUDE_BINARY, [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--max-turns', '30',
        '-p', prompt
    ], {
        cwd: worktreePath,  // Work in isolated worktree
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }  // Preserve API key!
    });

    // Close stdin after a brief delay to let Claude initialize
    setTimeout(() => {
        if (agentProcess.stdin && !agentProcess.stdin.destroyed) {
            agentProcess.stdin.end();
        }
    }, 500);

    subAgentData.process = agentProcess;
    subAgentData.stderrBuffer = '';  // Track stderr for debugging
    subAgentData.jsonBuffer = '';    // TASK-319: Buffer for JSON parsing

    // Initialize log file for this agent
    appendAgentLog(task.id, `=== Agent started for: ${task.title} ===`);
    appendAgentLog(task.id, `Worktree: ${worktreePath}`);

    // TASK-319: Parse stream-json output and broadcast real-time
    agentProcess.stdout.on('data', (data) => {
        subAgentData.jsonBuffer = parseAndBroadcastOrchOutput(
            orch.id,
            task.id,
            data.toString(),
            subAgentData,
            subAgentData.jsonBuffer
        );

        // Also log raw chunk count for debugging
        console.log(`[Orchestrator] Task ${task.id} output chunks: ${subAgentData.output.length}`);
    });

    agentProcess.stderr.on('data', (data) => {
        const error = data.toString();
        subAgentData.output.push({ type: 'stderr', text: error, time: Date.now() });
        subAgentData.stderrBuffer += error;
        appendAgentLog(task.id, `[STDERR] ${error}`);
        console.log(`[Orchestrator] Task ${task.id} stderr: ${error}`);
    });

    agentProcess.on('close', (code) => {
        subAgentData.endTime = Date.now();
        const stats = getOrchestrationStats(orch);
        const duration = subAgentData.endTime - subAgentData.startTime;

        console.log(`[Orchestrator] Task ${task.id} closed with code ${code} after ${duration}ms`);
        if (code !== 0 && subAgentData.stderrBuffer) {
            console.log(`[Orchestrator] Task ${task.id} stderr: ${subAgentData.stderrBuffer}`);
        }

        if (code === 0) {
            subAgentData.status = 'completed';

            // Get diff summary from worktree (don't auto-merge!)
            let diffSummary = '';
            let filesChanged = 0;
            try {
                if (subAgentData.worktreePath && subAgentData.branchName) {
                    // Get diff stat against the branch base
                    diffSummary = execSync(`git diff --stat HEAD~1 2>/dev/null || git diff --stat HEAD`, {
                        cwd: subAgentData.worktreePath,
                        encoding: 'utf8',
                        stdio: ['pipe', 'pipe', 'pipe']
                    }).trim();

                    // Count files changed
                    const match = diffSummary.match(/(\d+) files? changed/);
                    filesChanged = match ? parseInt(match[1]) : 0;
                }
            } catch (err) {
                console.log(`[Orchestrator] Could not get diff summary: ${err.message}`);
                diffSummary = 'Unable to retrieve diff';
            }

            // Broadcast task_completed with diff info for review
            broadcastOrchestration(orch.id, {
                type: 'task_completed',
                taskId: task.id,
                task: task,
                branch: subAgentData.branchName,
                worktree: subAgentData.worktreePath,
                diffSummary: diffSummary,
                filesChanged: filesChanged,
                stats: stats,
                reviewCommands: {
                    viewDiff: `git diff ${subAgentData.branchName}`,
                    merge: `git merge ${subAgentData.branchName} --no-ff -m "Orchestrator: ${task.title}"`,
                    discard: `git worktree remove ${subAgentData.worktreePath} --force && git branch -D ${subAgentData.branchName}`
                },
                message: `✅ Completed: ${task.title} (${filesChanged} files changed)`
            });
        } else {
            // Failed - check retries
            if (subAgentData.retries < orch.maxRetries) {
                subAgentData.retries++;
                subAgentData.status = 'retrying';

                // Cleanup failed worktree before retry
                if (subAgentData.worktreePath) {
                    cleanupWorktree(`orch-${task.id}`);
                }

                broadcastOrchestration(orch.id, {
                    type: 'task_retrying',
                    taskId: task.id,
                    task: task,
                    retries: subAgentData.retries,
                    maxRetries: orch.maxRetries,
                    stats: stats,
                    message: `⚠️ ${task.title} failed. Retrying (${subAgentData.retries}/${orch.maxRetries})...`
                });

                // Remove from subAgents to allow retry
                const idx = orch.subAgents.findIndex(a => a.taskId === task.id);
                if (idx >= 0) orch.subAgents.splice(idx, 1);

                // Retry after delay
                setTimeout(() => spawnSubAgent(orch, task), 2000);
            } else {
                subAgentData.status = 'failed';

                // Cleanup failed worktree
                if (subAgentData.worktreePath) {
                    cleanupWorktree(`orch-${task.id}`);
                }

                broadcastOrchestration(orch.id, {
                    type: 'task_failed',
                    taskId: task.id,
                    task: task,
                    stats: stats,
                    message: `❌ ${task.title} failed after ${orch.maxRetries} retries. Please review.`,
                    error: subAgentData.output.slice(-5).join('')
                });
            }
        }

        // Execute next tasks
        executeNextTasks(orch);
    });

    agentProcess.on('error', (err) => {
        subAgentData.status = 'error';
        broadcastOrchestration(orch.id, {
            type: 'error',
            taskId: task.id,
            message: `Error spawning agent: ${err.message}`
        });
    });
}

// ============================================================
// TASK-SPECIFIC ROUTES - Must be defined BEFORE generic :id routes
// ============================================================

// GET /api/orchestrator/task/:taskId/diff - Get full diff for a task
app.get('/api/orchestrator/task/:taskId/diff', (req, res) => {
    const taskId = req.params.taskId;
    const branch = req.query.branch;

    if (!branch) {
        return res.status(400).json({ error: 'Branch parameter required' });
    }

    const projectRoot = path.join(__dirname, '..');

    try {
        // Get the diff between the branch and master
        const diff = execSync(`git diff master...${branch}`, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024  // 10MB buffer for large diffs
        });

        res.json({ success: true, diff: diff });
    } catch (err) {
        console.error(`[Orchestrator] Error getting diff for ${taskId}:`, err.message);
        res.status(500).json({ error: `Failed to get diff: ${err.message}` });
    }
});

// POST /api/orchestrator/task/:taskId/merge - Merge a task's branch
app.post('/api/orchestrator/task/:taskId/merge', (req, res) => {
    const taskId = req.params.taskId;
    const { branch, worktree } = req.body;

    if (!branch) {
        return res.status(400).json({ error: 'Branch required' });
    }

    const projectRoot = path.join(__dirname, '..');

    try {
        // First, checkout master
        execSync(`git checkout master`, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Merge the branch with a descriptive commit message
        execSync(`git merge ${branch} --no-ff -m "Orchestrator: Merge ${branch}"`, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        console.log(`[Orchestrator] Merged branch ${branch}`);

        // Clean up: remove worktree and branch
        if (worktree) {
            try {
                execSync(`git worktree remove "${worktree}" --force`, {
                    cwd: projectRoot,
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                console.log(`[Orchestrator] Removed worktree ${worktree}`);
            } catch (e) {
                console.warn(`[Orchestrator] Could not remove worktree: ${e.message}`);
            }
        }

        // Delete the branch after merge
        try {
            execSync(`git branch -d ${branch}`, {
                cwd: projectRoot,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            console.log(`[Orchestrator] Deleted branch ${branch}`);
        } catch (e) {
            console.warn(`[Orchestrator] Could not delete branch: ${e.message}`);
        }

        res.json({ success: true, message: `Merged ${branch}` });
    } catch (err) {
        console.error(`[Orchestrator] Error merging ${taskId}:`, err.message);
        res.status(500).json({ error: `Merge failed: ${err.message}` });
    }
});

// POST /api/orchestrator/task/:taskId/discard - Discard a task's worktree and branch
app.post('/api/orchestrator/task/:taskId/discard', (req, res) => {
    const taskId = req.params.taskId;
    const { branch, worktree } = req.body;

    const projectRoot = path.join(__dirname, '..');

    try {
        // Remove worktree first (if exists)
        if (worktree) {
            try {
                execSync(`git worktree remove "${worktree}" --force`, {
                    cwd: projectRoot,
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                console.log(`[Orchestrator] Removed worktree ${worktree}`);
            } catch (e) {
                console.warn(`[Orchestrator] Worktree removal: ${e.message}`);
            }
        }

        // Delete the branch
        if (branch) {
            try {
                execSync(`git branch -D ${branch}`, {
                    cwd: projectRoot,
                    encoding: 'utf8',
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                console.log(`[Orchestrator] Force deleted branch ${branch}`);
            } catch (e) {
                console.warn(`[Orchestrator] Branch deletion: ${e.message}`);
            }
        }

        res.json({ success: true, message: `Discarded task ${taskId}` });
    } catch (err) {
        console.error(`[Orchestrator] Error discarding ${taskId}:`, err.message);
        res.status(500).json({ error: `Discard failed: ${err.message}` });
    }
});

// ============================================================
// GENERIC :id ROUTES - After task-specific routes
// ============================================================

// GET /api/orchestrator/:id - Get orchestration status
app.get('/api/orchestrator/:id', (req, res) => {
    const orch = orchestrations.get(req.params.id);

    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    res.json({
        id: orch.id,
        goal: orch.goal,
        phase: orch.phase,
        status: orch.status,
        questions: orch.questions,
        answers: orch.answers,
        plan: orch.plan,
        subAgents: orch.subAgents.map(a => ({
            taskId: a.taskId,
            title: a.task?.title,
            status: a.status,
            retries: a.retries,
            outputLines: a.output?.length || 0
        })),
        summary: orch.summary.slice(-20),
        startTime: orch.startTime,
        runtime: Date.now() - orch.startTime
    });
});

// DELETE /api/orchestrator/:id - Delete an orchestration
app.delete('/api/orchestrator/:id', (req, res) => {
    const orchId = req.params.id;
    const orch = orchestrations.get(orchId);

    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    // Kill any running sub-agents
    for (const agent of orch.subAgents) {
        if (agent.process && !agent.process.killed) {
            agent.process.kill('SIGTERM');
        }
    }

    // Remove from orchestrations map
    orchestrations.delete(orchId);
    debouncedSave();

    // Remove SSE clients for this orchestration
    if (orchestratorClients.has(orchId)) {
        orchestratorClients.delete(orchId);
    }

    console.log(`[Orchestrator] Deleted ${orchId}`);
    res.json({ success: true, message: 'Orchestration deleted' });
});

// POST /api/orchestrator/:id/chat - Chat with orchestrator at current phase
app.post('/api/orchestrator/:id/chat', async (req, res) => {
    const { message, phase } = req.body;
    const orch = orchestrations.get(req.params.id);

    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    // Build context-aware prompt based on phase
    let contextPrompt = `You are an orchestration assistant helping with: "${orch.goal}"

Current phase: ${phase || orch.phase}
`;

    // Add phase-specific context
    if (orch.answers && Object.keys(orch.answers).length > 0) {
        contextPrompt += `\nUser's answers so far:\n${JSON.stringify(orch.answers, null, 2)}`;
    }
    if (orch.plan && orch.plan.length > 0) {
        contextPrompt += `\nCurrent plan:\n${orch.plan.map((t, i) => `${i+1}. ${t.title}`).join('\n')}`;
    }

    // Add execution-specific context
    if (phase === 'execution' || orch.phase === 'execution') {
        contextPrompt += `\nExecution is in progress. Running tasks may include agents working on the plan.`;
        contextPrompt += `\nYou can help the user understand progress, pause/modify execution, or answer questions about the work being done.`;
    }

    contextPrompt += `\n\nUser message: "${message}"

Respond helpfully and in a structured way. Use bullet points or numbered lists when listing multiple items.
If they're asking for clarification, explain clearly with specific details.
If they're requesting changes, acknowledge and suggest how to proceed.
Format your response for readability - use **bold** for emphasis, \`code\` for technical terms.
Keep responses concise but complete (3-5 sentences).`;

    try {
        const chatProcess = spawn(CLAUDE_BINARY, ['--print', '-p', contextPrompt], {
            cwd: path.join(__dirname, '..'),
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        // Close stdin immediately
        chatProcess.stdin.end();

        let response = '';
        chatProcess.stdout.on('data', (data) => {
            response += data.toString();
        });

        chatProcess.stderr.on('data', (data) => {
            console.log('[Chat] stderr:', data.toString());
        });

        chatProcess.on('close', (code) => {
            if (code === 0 && response.trim()) {
                // Store in conversation history
                if (!orch.chatHistory) orch.chatHistory = [];
                orch.chatHistory.push({ role: 'user', message });
                orch.chatHistory.push({ role: 'assistant', message: response.trim() });

                res.json({ success: true, response: response.trim() });
            } else {
                res.status(500).json({ error: 'Failed to generate response' });
            }
        });

        chatProcess.on('error', (err) => {
            console.error('[Chat] Process error:', err);
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/orchestrator/:id/more-questions - Request more clarifying questions
app.post('/api/orchestrator/:id/more-questions', async (req, res) => {
    const orch = orchestrations.get(req.params.id);

    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    console.log(`[Orchestrator] Generating more questions for ${req.params.id}`);

    // Build a summary of questions already asked
    const existingQuestions = (orch.questions || []).map(q => q.question).join('\n- ');

    const prompt = `You are a senior requirements analyst. Think carefully before asking more questions.

PROJECT GOAL:
"${orch.goal}"

QUESTIONS ALREADY ASKED:
- ${existingQuestions}

USER'S ANSWERS SO FAR:
${JSON.stringify(orch.answers, null, 2)}

${orch.plan && orch.plan.length > 0 ? `CURRENT PLAN:\n${orch.plan.map((t, i) => `${i+1}. ${t.title}: ${t.description || ''}`).join('\n')}` : ''}

YOUR TASK:
1. First, carefully analyze what the user has ALREADY told you through their answers
2. Identify what you STILL DON'T KNOW that would be critical for implementation
3. DO NOT repeat or rephrase questions that were already asked
4. Only ask questions that reveal genuinely NEW information

If the user's answers are comprehensive and you have enough information to proceed, respond with:
{"sufficient": true, "reason": "Brief explanation of why no more questions are needed"}

If you genuinely need more information, output 1-3 NEW questions (not rephrased versions of existing ones):
[
  {"id": "deep-1", "question": "...", "options": [...], "type": "choice|multiselect", "multiSelect": true|false}
]

Rules for new questions:
- Each question must ask about something NOT covered by previous questions/answers
- Include 2-5 options when possible (not open-ended unless necessary)
- Use multiSelect: true when multiple options can apply together
- Focus on: implementation details, edge cases, technical constraints, UX specifics

Think step by step: What do I already know? What critical gaps remain?`;

    try {
        const questionsProcess = spawn(CLAUDE_BINARY, ['--print', '-p', prompt], {
            cwd: path.join(__dirname, '..'),
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let output = '';
        questionsProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        questionsProcess.stderr.on('data', (data) => {
            console.log('[MoreQuestions] stderr:', data.toString());
        });

        questionsProcess.on('close', (code) => {
            if (code === 0 && output.trim()) {
                try {
                    // Check if Claude said no more questions needed
                    const sufficientMatch = output.match(/\{"sufficient"\s*:\s*true[^}]*\}/);
                    if (sufficientMatch) {
                        try {
                            const sufficientResponse = JSON.parse(sufficientMatch[0]);
                            console.log('[MoreQuestions] Claude says sufficient:', sufficientResponse.reason);
                            return res.json({
                                success: true,
                                sufficient: true,
                                reason: sufficientResponse.reason || 'Your answers are comprehensive enough to proceed.',
                                newQuestions: [],
                                allQuestions: orch.questions,
                                message: sufficientResponse.reason || 'No additional questions needed - ready to generate plan!'
                            });
                        } catch (e) {
                            // Fall through to try parsing as questions
                        }
                    }

                    // Try to parse as questions array
                    const jsonMatch = output.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const newQuestions = JSON.parse(jsonMatch[0]);

                        // Ensure unique IDs
                        const existingIds = new Set(orch.questions?.map(q => q.id) || []);
                        newQuestions.forEach((q, i) => {
                            if (existingIds.has(q.id)) {
                                q.id = `deep-${Date.now()}-${i}`;
                            }
                        });

                        // Add to questions list
                        if (!orch.questions) orch.questions = [];
                        orch.questions.push(...newQuestions);

                        // Return to questions phase so user can answer
                        orch.phase = 'questions';
                        debouncedSave();

                        // Broadcast the update
                        broadcastOrchestration(orch.id, {
                            type: 'questions',
                            questions: orch.questions,
                            message: `Added ${newQuestions.length} new clarifying questions`
                        });

                        res.json({
                            success: true,
                            newQuestions,
                            allQuestions: orch.questions,
                            message: `Added ${newQuestions.length} new questions`
                        });
                    } else {
                        res.status(500).json({ error: 'Could not parse questions from response' });
                    }
                } catch (parseErr) {
                    console.error('[MoreQuestions] Parse error:', parseErr);
                    res.status(500).json({ error: 'Failed to parse questions JSON' });
                }
            } else {
                res.status(500).json({ error: 'Failed to generate questions' });
            }
        });

        questionsProcess.on('error', (err) => {
            console.error('[MoreQuestions] Process error:', err);
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/orchestrator/:id/task/:taskId/chat - Chat about a specific plan task
app.post('/api/orchestrator/:id/task/:taskId/chat', async (req, res) => {
    const { message } = req.body;
    const orch = orchestrations.get(req.params.id);
    const taskId = req.params.taskId;

    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    // Find the task in the plan
    const task = orch.plan?.find(t => t.id === taskId);
    if (!task) {
        return res.status(404).json({ error: 'Task not found in plan' });
    }

    console.log(`[Orchestrator] Task chat for ${taskId}: ${message.slice(0, 50)}...`);

    // Build context-aware prompt for this specific task
    const contextPrompt = `You are an orchestration assistant helping refine a software implementation plan.

OVERALL PROJECT GOAL: "${orch.goal}"

USER REQUIREMENTS (from Q&A):
${JSON.stringify(orch.answers, null, 2)}

CURRENT PLAN:
${orch.plan.map((t, i) => `${i+1}. [${t.id}] ${t.title}${t.id === taskId ? ' ← DISCUSSING THIS TASK' : ''}`).join('\n')}

SPECIFIC TASK BEING DISCUSSED:
- ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description || 'No description yet'}
- Agent Type: ${task.agentType || 'Not specified'}
- Dependencies: ${task.dependencies?.join(', ') || 'None'}

USER'S QUESTION/FEEDBACK ABOUT THIS TASK:
"${message}"

Respond helpfully about this specific task:
- If they want changes, suggest how to modify the task
- If they need clarification, explain the technical approach
- If they have concerns, address them directly
- Suggest improvements if relevant

Keep response focused and concise (2-4 sentences). If the user wants to modify the task, explain what changes you recommend.`;

    try {
        const chatProcess = spawn(CLAUDE_BINARY, ['--print', '-p', contextPrompt], {
            cwd: path.join(__dirname, '..'),
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let response = '';
        chatProcess.stdout.on('data', (data) => {
            response += data.toString();
        });

        chatProcess.stderr.on('data', (data) => {
            console.log('[TaskChat] stderr:', data.toString());
        });

        chatProcess.on('close', (code) => {
            if (code === 0 && response.trim()) {
                // Store chat history per task
                if (!orch.taskChatHistory) orch.taskChatHistory = {};
                if (!orch.taskChatHistory[taskId]) orch.taskChatHistory[taskId] = [];

                orch.taskChatHistory[taskId].push(
                    { role: 'user', message, timestamp: Date.now() },
                    { role: 'assistant', message: response.trim(), timestamp: Date.now() }
                );

                debouncedSave();

                res.json({
                    success: true,
                    response: response.trim(),
                    taskId,
                    chatHistory: orch.taskChatHistory[taskId]
                });
            } else {
                res.status(500).json({ error: 'Failed to generate response' });
            }
        });

        chatProcess.on('error', (err) => {
            console.error('[TaskChat] Process error:', err);
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/orchestrator/:id/deepen - Generate more questions or explanations
app.post('/api/orchestrator/:id/deepen', async (req, res) => {
    const { mode } = req.body; // 'questions' or 'explain'
    const orch = orchestrations.get(req.params.id);

    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    let prompt;
    if (mode === 'questions') {
        prompt = `You are a requirements analyst. The user wants to build:
"${orch.goal}"

They already answered these questions:
${JSON.stringify(orch.answers, null, 2)}

Generate 2-3 MORE clarifying questions to deepen understanding.
Focus on:
- Edge cases they might not have considered
- Technical trade-offs
- User experience details
- Performance/scalability concerns

Output ONLY a JSON array of questions:
[{"id": "deep-1", "question": "...", "type": "text"}]`;
    } else {
        // mode === 'explain'
        prompt = `You are explaining your planning process. The user wants to build:
"${orch.goal}"

Current phase: ${orch.phase}
${orch.plan && orch.plan.length > 0 ? `Current plan:\n${orch.plan.map(t => `- ${t.title}: ${t.description}`).join('\n')}` : ''}

Explain your reasoning:
1. Why you chose this approach
2. Key technical decisions made
3. Potential alternatives considered
4. What you need more clarity on

Keep it conversational and concise (3-5 sentences).`;
    }

    try {
        const deepenProcess = spawn(CLAUDE_BINARY, ['--print', '-p', prompt], {
            cwd: path.join(__dirname, '..'),
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env, ANTHROPIC_API_KEY: '' }
        });

        let output = '';
        deepenProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        deepenProcess.stderr.on('data', (data) => {
            console.log('[Deepen] stderr:', data.toString());
        });

        deepenProcess.on('close', (code) => {
            if (code === 0 && output.trim()) {
                if (mode === 'questions') {
                    // Parse and add new questions
                    try {
                        const jsonMatch = output.match(/\[[\s\S]*\]/);
                        if (jsonMatch) {
                            const newQuestions = JSON.parse(jsonMatch[0]);
                            if (!orch.questions) orch.questions = [];
                            orch.questions.push(...newQuestions);

                            res.json({
                                success: true,
                                newQuestions,
                                questions: orch.questions
                            });
                        } else {
                            res.status(500).json({ error: 'Could not parse questions' });
                        }
                    } catch (parseErr) {
                        res.status(500).json({ error: 'Failed to parse questions JSON' });
                    }
                } else {
                    // Return explanation
                    res.json({ success: true, explanation: output.trim() });
                }
            } else {
                res.status(500).json({ error: 'Failed to deepen understanding' });
            }
        });

        deepenProcess.on('error', (err) => {
            console.error('[Deepen] Process error:', err);
            res.status(500).json({ error: err.message });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/orchestrator/:id/stream - SSE stream for orchestration updates
app.get('/api/orchestrator/:id/stream', (req, res) => {
    const orchId = req.params.id;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send only the last few summaries to avoid flooding on reconnect
    const orch = orchestrations.get(orchId);
    if (orch) {
        // Only send the last 5 entries to avoid repetitive flooding
        const recentSummaries = orch.summary.slice(-5);
        for (const entry of recentSummaries) {
            res.write(`data: ${JSON.stringify({ orchestrationId: orchId, ...entry })}\n\n`);
        }
    }

    // Add to clients
    if (!orchestratorClients.has(orchId)) {
        orchestratorClients.set(orchId, []);
    }
    orchestratorClients.get(orchId).push(res);

    // Keep alive
    const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
    }, 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        const clients = orchestratorClients.get(orchId) || [];
        orchestratorClients.set(orchId, clients.filter(c => c !== res));
    });
});

// POST /api/orchestrator/:id/refine - Submit refinements after review
app.post('/api/orchestrator/:id/refine', (req, res) => {
    const orchId = req.params.id;
    const { feedback, action } = req.body;

    const orch = orchestrations.get(orchId);
    if (!orch) {
        return res.status(404).json({ error: 'Orchestration not found' });
    }

    if (action === 'approve') {
        orch.status = 'completed';
        broadcastOrchestration(orch.id, {
            type: 'complete',
            message: '🎉 Project approved and completed!'
        });

        return res.json({ success: true, message: 'Project completed!' });
    }

    if (action === 'refine' && feedback) {
        // Add refinement tasks based on feedback
        broadcastOrchestration(orch.id, {
            type: 'summary',
            message: `📝 Processing feedback: ${feedback.slice(0, 100)}...`
        });

        // Generate new tasks from feedback
        generateRefinementTasks(orch, feedback);

        return res.json({ success: true, message: 'Processing refinements...' });
    }

    res.status(400).json({ error: 'Invalid action' });
});

// Helper: Generate tasks from refinement feedback
async function generateRefinementTasks(orch, feedback) {
    const prompt = `Based on user feedback, create additional tasks:

ORIGINAL GOAL: ${orch.goal}
COMPLETED TASKS: ${orch.plan.map(t => t.title).join(', ')}

USER FEEDBACK:
${feedback}

Create 1-5 new tasks to address this feedback. Output as JSON array:
[{"id": "refine-1", "title": "...", "description": "...", "agentType": "...", "dependencies": [], "priority": "P1"}]`;

    const refineProcess = spawn(CLAUDE_BINARY, ['--print', '-p', prompt], {
        cwd: path.join(__dirname, '..'),
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, ANTHROPIC_API_KEY: '' }
    });

    let output = '';
    refineProcess.stdout.on('data', (d) => output += d.toString());
    refineProcess.stderr.on('data', (d) => console.log(`[Orchestrator] Refine stderr: ${d.toString()}`));

    refineProcess.on('close', (code) => {
        if (code === 0) {
            try {
                const jsonMatch = output.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const newTasks = JSON.parse(jsonMatch[0]);
                    orch.plan.push(...newTasks);
                    orch.phase = 'execution';

                    broadcastOrchestration(orch.id, {
                        type: 'plan',
                        plan: orch.plan,
                        message: `Added ${newTasks.length} refinement tasks. Resuming execution...`
                    });

                    executeNextTasks(orch);
                }
            } catch (e) {
                console.error(`[Orchestrator] Error parsing refinement: ${e.message}`);
            }
        }
    });
}

// GET /api/locks - List active task locks
app.get('/api/locks', (req, res) => {
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : '';
    const locksDir = path.join(projectRoot, '.claude', 'locks');

    try {
        if (!fs.existsSync(locksDir)) {
            return res.json({ locks: [] });
        }

        const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.lock'));
        const locks = [];

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(locksDir, file), 'utf8');
                const lock = JSON.parse(content);
                const taskId = file.replace('.lock', '');

                locks.push({
                    task_id: taskId,
                    session_id: lock.session_id || 'unknown',
                    session_short: (lock.session_id || '').slice(0, 8),
                    locked_at: lock.locked_at || new Date(lock.timestamp * 1000).toLocaleString(),
                    files: lock.files_touched || lock.files || []
                });
            } catch (e) {
                // Skip invalid lock files
            }
        }

        res.json({ locks });
    } catch (err) {
        res.json({ locks: [], error: err.message });
    }
});

// GET /api/deferred - List deferred edits queue
app.get('/api/deferred', (req, res) => {
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : '';
    const deferredDir = path.join(projectRoot, '.claude', 'deferred-queue');

    try {
        if (!fs.existsSync(deferredDir)) {
            return res.json({ sessions: [], total: 0 });
        }

        const files = fs.readdirSync(deferredDir).filter(f => f.endsWith('.json'));
        const sessions = [];
        let total = 0;

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(deferredDir, file), 'utf8');
                const queue = JSON.parse(content);
                const sessionId = file.replace('.json', '');

                if (queue.deferred_edits && queue.deferred_edits.length > 0) {
                    sessions.push({
                        session_id: sessionId,
                        session_short: sessionId.slice(0, 8),
                        edits: queue.deferred_edits.map(e => ({
                            file: e.file,
                            blocked_by: e.blocked_by_task,
                            timestamp: e.timestamp,
                            waiting_since: new Date(e.timestamp * 1000).toLocaleString()
                        }))
                    });
                    total += queue.deferred_edits.length;
                }
            } catch (e) {
                // Skip invalid queue files
            }
        }

        res.json({ sessions, total });
    } catch (err) {
        res.json({ sessions: [], total: 0, error: err.message });
    }
});

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
    const url = `http://localhost:${PORT}`;
    // Use ANSI escape codes to make URL clickable in terminals that support it (iTerm2, VS Code, etc.)
    console.log(`Dev Maestro running at \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`);
    console.log(`Serving static files from: ${__dirname}`);

    // Setup file watchers for real-time lock monitoring
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    if (masterPlanPath) {
        const projectRoot = getProjectRoot(masterPlanPath);
        if (projectRoot) {
            setupFileWatchers(projectRoot);
        }
    }
});
