const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();
const taskEngine = require('./modules/task-engine');
const projectScanner = require('./modules/project-scanner');
const changelogEngine = require('./modules/changelog-engine');
const { resolveMasterPlanPath } = require('./modules/master-plan-path');
const mountControlRoomRoutes = require('./controlroom/api');
const mountVpsRoutes = require('./vps/api');

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


// Cache for health scan results
let healthCache = null;
let healthScanInProgress = false;

// SSE Clients
let clients = [];
let changelogClients = [];

// Helper to broadcast logs to SSE clients
const broadcastLog = (message) => {
    // Send log event
    const payload = JSON.stringify({ type: 'log', message });
    clients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
    });
};

// Helper to resolve the active Master Plan path.
const getMasterPlanResolution = () => resolveMasterPlanPath({
    envPath: process.env.MASTER_PLAN_PATH,
    localConfig,
    rootDir: __dirname,
    existsSync: fs.existsSync
});

const getMasterPlanPath = () => getMasterPlanResolution().path;


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

// 6. Mount Control Room routes (enriched projects, stats, summaries, covers)
mountControlRoomRoutes(app);

// 7. Mount VPS monitor routes (/api/vps/status, /api/vps/bots, /api/vps/cover/:id)
mountVpsRoutes(app);

// Status API - for Claude to detect if Watchpost is running
app.get('/api/status', (req, res) => {
    const pkg = require('./package.json');
    const masterPlanResolution = getMasterPlanResolution();

    res.json({
        running: true,
        name: 'Watchpost',
        version: pkg.version,
        port: PORT,
        project: path.dirname(masterPlanResolution.path),
        masterPlanPath: masterPlanResolution.path,
        masterPlanSource: masterPlanResolution.source,
        masterPlanExists: masterPlanResolution.exists,
        uptime: process.uptime(),
        url: `http://localhost:${PORT}`
    });
});

// Self-description API - helps Claude Code instances discover capabilities
app.get('/api/discover', (req, res) => {
    const pkg = require('./package.json');
    res.json({
        name: 'Watchpost',
        description: 'AI orchestration dashboard and task management for multi-project development. Tracks tasks from MASTER_PLAN.md, provides health scanning, agent orchestration, changelog tracking, and cross-project context.',
        version: pkg.version,
        port: PORT,
        endpoints: {
            status: { method: 'GET', path: '/api/status', description: 'Server health, active project, uptime' },
            discover: { method: 'GET', path: '/api/discover', description: 'This endpoint — full API manifest' },
            projects: { method: 'GET', path: '/api/projects', description: 'All registered projects with paths and MASTER_PLAN locations' },
            'master-plan': { method: 'GET', path: '/api/master-plan', description: 'Full parsed MASTER_PLAN.md — tasks, statuses, dependencies' },
            'next-id': { method: 'GET', path: '/api/next-id', description: 'Next available task ID for the active project' },
            'task-update': { method: 'POST', path: '/api/task/:id/status', description: 'Update task status (planned/in_progress/done/review)' },
            'task-add': { method: 'POST', path: '/api/task/add', description: 'Add a new task to MASTER_PLAN.md' },
            health: { method: 'GET', path: '/api/health', description: 'Full project health scan (async)' },
            'health-quick': { method: 'GET', path: '/api/health/quick', description: 'Quick health check' },
            'health-report': { method: 'GET', path: '/api/health/report/json', description: 'Machine-readable health report' },
            skills: { method: 'GET', path: '/api/skills', description: 'Available Claude Code skills for the project' },
            docs: { method: 'GET', path: '/api/docs', description: 'Documentation files in the project' },
            'beads-ready': { method: 'GET', path: '/api/beads/ready', description: 'Tasks with all dependencies resolved (ready to work on)' },
            outlook: { method: 'GET', path: '/api/outlook', description: 'Cross-project digest for session context (supports ?format=markdown). Aggregates task stats, git activity, and top in-progress tasks across all registered projects. 5-min cache.' },
            'beads-graph': { method: 'GET', path: '/api/beads/graph', description: 'Full task dependency graph' },
            'beads-claim': { method: 'POST', path: '/api/beads/claim/:id', description: 'Claim a task (sets IN PROGRESS)' },
            'beads-close': { method: 'POST', path: '/api/beads/close/:id', description: 'Close a task (sets DONE)' },
            changelog: { method: 'GET', path: '/api/changelog', description: 'Session changelog data' },
            events: { method: 'GET', path: '/api/events', description: 'Server-sent events stream for live updates' }
        },
        cli: {
            binary: '~/.local/bin/watchpost',
            commands: ['tui', 'dashboard', 'status', 'stop', 'install', 'archive', 'discover', 'help']
        },
        data: {
            changelog_db: '~/.watchpost/data/changelog.db',
            projects_registry: '~/.watchpost/projects.json',
            per_project_db: '.watchpost/db.sqlite'
        },
        tips_for_claude: [
            'Check /api/status first to see which project is active',
            'Use /api/master-plan to get all tasks without reading the markdown file',
            'Use /api/outlook for a cross-project digest (all registered projects, task counts, git activity)',
            'Use /api/beads/ready to find tasks you can start immediately',
            'Use /api/health/quick for a fast project health assessment',
            'The changelog.db SQLite has session history across all projects'
        ]
    });
});

// ============================================================================
// RUNTIME CONFIG API - For AI agents to configure Watchpost without restart
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
    const masterPlanResolution = getMasterPlanResolution();
    const masterPlanPath = masterPlanResolution.path;

    console.log(`[API] Fetching MASTER_PLAN.md from: ${masterPlanPath}`);

    fs.readFile(masterPlanPath, 'utf8', (err, data) => {
        if (err) {
            console.error(`[API] Error reading MASTER_PLAN.md: ${err.message}`);
            return res.status(500).json({
                error: 'Failed to read MASTER_PLAN.md',
                details: err.message,
                path: masterPlanPath,
                source: masterPlanResolution.source
            });
        }
        res.json({ content: data, path: masterPlanPath, source: masterPlanResolution.source });
    });
});

// Middleware to parse JSON bodies
app.use(express.json());

// ============================================================================
// MULTI-PROJECT API
// ============================================================================

const projectsJsonPath = path.join(__dirname, 'projects.json');

// Helper: Read projects.json
const readProjects = () => {
    if (!fs.existsSync(projectsJsonPath)) {
        return { projects: [] };
    }
    try {
        return JSON.parse(fs.readFileSync(projectsJsonPath, 'utf8'));
    } catch (e) {
        console.warn('[Projects] Failed to parse projects.json:', e.message);
        return { projects: [] };
    }
};

// Helper: Write projects.json
const writeProjects = (data) => {
    fs.writeFileSync(projectsJsonPath, JSON.stringify(data, null, 2) + '\n');
};

// GET /api/projects - List all registered projects
app.get('/api/projects', (req, res) => {
    const data = readProjects();
    const currentPlan = process.env.MASTER_PLAN_PATH
        ? path.resolve(process.env.MASTER_PLAN_PATH)
        : '';

    const projects = data.projects.map(p => ({
        ...p,
        active: currentPlan === p.masterPlan
    }));

    res.json({ projects });
});

// POST /api/projects - Register a new project
app.post('/api/projects', (req, res) => {
    const { name, root, masterPlan, modules } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Missing required field: name' });
    }
    if (!root) {
        return res.status(400).json({ error: 'Missing required field: root' });
    }

    const resolvedRoot = path.resolve(root);
    if (!fs.existsSync(resolvedRoot)) {
        return res.status(400).json({ error: 'Project root does not exist', root: resolvedRoot });
    }

    const data = readProjects();

    if (data.projects.some(p => p.name === name)) {
        return res.status(409).json({ error: `Project "${name}" already exists` });
    }

    // Auto-detect masterPlan if not provided
    let resolvedPlan = masterPlan ? path.resolve(masterPlan) : findMasterPlan(resolvedRoot);

    const entry = {
        name,
        root: resolvedRoot,
        masterPlan: resolvedPlan || null,
        modules: modules || [],
        addedAt: new Date().toISOString().split('T')[0]
    };

    data.projects.push(entry);
    writeProjects(data);

    console.log(`[Projects] Registered new project: ${name}`);
    res.status(201).json(entry);
});

// DELETE /api/projects/:name - Remove a project from the registry
app.delete('/api/projects/:name', (req, res) => {
    const { name } = req.params;
    const data = readProjects();

    const idx = data.projects.findIndex(p => p.name === name);
    if (idx === -1) {
        return res.status(404).json({ error: `Project "${name}" not found` });
    }

    const removed = data.projects.splice(idx, 1)[0];
    writeProjects(data);

    console.log(`[Projects] Removed project: ${name}`);
    res.json({ removed });
});

// GET /api/projects/scan - Trigger manual project scan
app.get('/api/projects/scan', (req, res) => {
    const scanPaths = localConfig.projectScanPaths || [process.env.HOME];
    const scanDepth = localConfig.projectScanDepth || 5;

    try {
        const result = projectScanner.syncDiscoveredProjects(scanPaths, projectsJsonPath, { maxDepth: scanDepth });
        console.log(`[Scanner] Manual scan: ${result.total} projects (${result.added.length} new)`);
        res.json(result);
    } catch (err) {
        console.error('[Scanner] Manual scan failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/projects/scan-paths - Update scan paths configuration
app.post('/api/projects/scan-paths', express.json(), (req, res) => {
    const { scanPaths, scanDepth } = req.body;

    if (scanPaths && !Array.isArray(scanPaths)) {
        return res.status(400).json({ error: 'scanPaths must be an array of directory paths' });
    }

    if (scanPaths) localConfig.projectScanPaths = scanPaths;
    if (typeof scanDepth === 'number') localConfig.projectScanDepth = scanDepth;

    // Persist to local/config.json
    try {
        const localConfigDir = path.join(__dirname, 'local');
        if (!fs.existsSync(localConfigDir)) fs.mkdirSync(localConfigDir, { recursive: true });
        const configPath = path.join(localConfigDir, 'config.json');
        const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
        if (scanPaths) existing.projectScanPaths = scanPaths;
        if (typeof scanDepth === 'number') existing.projectScanDepth = scanDepth;
        fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
    } catch (err) {
        console.error('[Config] Failed to persist scan paths:', err.message);
    }

    res.json({ scanPaths: localConfig.projectScanPaths, scanDepth: localConfig.projectScanDepth });
});

// POST /api/projects/reorder - Persist custom project order
app.post('/api/projects/reorder', (req, res) => {
    const { order } = req.body;

    if (!Array.isArray(order)) {
        return res.status(400).json({ error: 'Body must have an "order" array of project names' });
    }

    const data = readProjects();

    // Reorder: projects in the given order first, then any remaining at the end
    const orderMap = new Map(order.map((name, i) => [name, i]));
    const reordered = [
        ...order
            .map(name => data.projects.find(p => p.name === name))
            .filter(Boolean),
        ...data.projects.filter(p => !orderMap.has(p.name))
    ];

    data.projects = reordered;
    writeProjects(data);

    console.log(`[Projects] Custom order saved (${reordered.length} projects)`);
    res.json({ ok: true, count: reordered.length });
});

// POST /api/projects/:name/activate - Switch active project without restart
app.post('/api/projects/:name/activate', async (req, res) => {
    const { name } = req.params;
    const data = readProjects();

    const project = data.projects.find(p => p.name === name);
    if (!project) {
        return res.status(404).json({ error: `Project "${name}" not found` });
    }

    if (!project.masterPlan) {
        return res.status(400).json({
            error: `Project "${name}" has no masterPlan path configured`
        });
    }

    // Update runtime environment
    process.env.MASTER_PLAN_PATH = project.masterPlan;

    // Persist to .env file
    updateEnvFile('MASTER_PLAN_PATH', project.masterPlan);

    console.log(`[Projects] Activated project: ${name} -> ${project.masterPlan}`);

    // Re-sync task engine with new project
    taskEngine.closeDb();

    // Small delay to ensure WAL lock is fully released
    let success = initTaskEngine();
    if (!success) {
        console.log('[Projects] Retrying task engine init after 500ms...');
        await new Promise(r => setTimeout(r, 500));
        success = initTaskEngine();
    }

    if (!success) {
        console.error(`[Projects] Task engine init failed for ${name} after retry`);
    }

    // Broadcast project change to SSE clients
    const payload = JSON.stringify({
        type: 'project-changed',
        project: { ...project, active: true }
    });
    clients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
    });

    const response = { activated: { ...project, active: true } };
    if (!success) {
        response.warning = 'Task engine sync failed — tasks may not load';
    }
    res.json(response);
});

// ============================================================================
// NATIVE TASK ENGINE (SQLite)
// ============================================================================
let taskEngineReady = false;

function initTaskEngine() {
    try {
        const masterPlanPath = getMasterPlanPath();
        if (!masterPlanPath || !fs.existsSync(masterPlanPath)) {
            console.log('[TaskEngine] No MASTER_PLAN.md found, skipping init');
            taskEngineReady = false;
            return false;
        }
        const projectRoot = getProjectRoot(masterPlanPath);
        const watchpostDir = path.join(projectRoot, '.watchpost');
        if (!fs.existsSync(watchpostDir)) fs.mkdirSync(watchpostDir, { recursive: true });
        const dbPath = path.join(watchpostDir, 'db.sqlite');
        taskEngine.initDb(dbPath);
        const count = taskEngine.syncFromMarkdown(masterPlanPath);
        taskEngineReady = true;
        console.log(`[TaskEngine] Initialized: ${count} tasks synced from ${path.basename(masterPlanPath)}`);
        return true;
    } catch (err) {
        console.error('[TaskEngine] Init failed:', err.message, err.stack);
        taskEngineReady = false;
        return false;
    }
}

// Initialize on startup
initTaskEngine();

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

    // Enforce max title length for dashboard readability
    const MAX_TITLE_LENGTH = 80;
    if (title.length > MAX_TITLE_LENGTH) {
        return res.status(400).json({
            error: `Title too long (${title.length} chars). Max ${MAX_TITLE_LENGTH} chars. Put details in the description field instead.`,
            title_length: title.length,
            max_length: MAX_TITLE_LENGTH
        });
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

function normalizeSkillName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/^\//, '')
        .trim();
}

function skillStateFile() {
    return path.join(__dirname, 'data', 'skills-state.json');
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

// GET /api/skills - Dynamically scan .claude/skills/ directory
app.get('/api/skills', (req, res) => {
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');

    try {
        const nodes = [];
        const links = [];
        const skillState = readSkillState();
        const triedByKey = new Map(skillState.triedSkills.map(item => [item.key, item]));
        const categoryColors = {
            'debugging': '#ef4444',
            'architecture': '#3b82f6',
            'workflow': '#10b981',
            'review': '#f59e0b',
            'research': '#8b5cf6',
            'design': '#ec4899',
            'default': '#6b7280'
        };

        const home = process.env.HOME || '/home/endlessblink';
        const skillRoots = [
            { source: 'codex', root: path.join(home, '.codex', 'skills') },
            { source: 'claude', root: path.join(home, '.claude', 'skills') },
            { source: 'agents', root: path.join(home, '.agents', 'skills') },
            { source: 'opencode', root: path.join(home, '.config', 'opencode', 'skills') },
            { source: 'project claude', root: path.join(projectRoot, '.claude', 'skills') },
            { source: 'project codex', root: path.join(projectRoot, '.codex', 'skills') },
            { source: 'project agents', root: path.join(projectRoot, '.agents', 'skills') }
        ];

        const seenRoots = new Set();
        const skillEntries = [];
        for (const skillRoot of skillRoots) {
            try {
                if (!fs.existsSync(skillRoot.root)) continue;
                const realRoot = fs.realpathSync.native(path.resolve(skillRoot.root));
                if (seenRoots.has(realRoot)) continue;
                seenRoots.add(realRoot);
                const entries = fs.readdirSync(skillRoot.root, { withFileTypes: true }).filter(d => d.isDirectory());
                for (const dir of entries) {
                    const skillPath = path.join(skillRoot.root, dir.name, 'SKILL.md');
                    if (fs.existsSync(skillPath)) skillEntries.push({ dir, skillPath, source: skillRoot.source });
                }
            } catch {
                // Skip unreadable skill roots.
            }
        }

        for (let i = 0; i < skillEntries.length; i++) {
            const { dir, skillPath, source } = skillEntries[i];

            try {
                const content = fs.readFileSync(skillPath, 'utf8');
                const contentLength = content.length;

                // Strip YAML frontmatter before parsing
                let parseContent = content;
                if (parseContent.startsWith('---')) {
                    const endIdx = parseContent.indexOf('---', 3);
                    if (endIdx > 0) parseContent = parseContent.substring(endIdx + 3).trim();
                }
                const lines = parseContent.split('\n');

                // Extract title from first # heading
                const titleLine = lines.find(l => l.startsWith('# '));
                const title = titleLine ? titleLine.replace('# ', '').trim() : dir.name;

                // Extract description from first real paragraph (skip headings, empty lines)
                const descStart = lines.findIndex(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
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

                const tried = triedByKey.get(normalizeSkillName(dir.name));

                nodes.push({
                    id: `skill:${source}:${dir.name}`,
                    type: 'skill',
                    name: dir.name,
                    folderName: dir.name,
                    title,
                    description,
                    category,
                    source,
                    path: skillPath,
                    modifiedAt: fs.statSync(skillPath).mtime.toISOString(),
                    color: categoryColors[category] || categoryColors.default,
                    contentLength,
                    usage: 0,
                    tried: Boolean(tried),
                    triedAt: tried?.triedAt || null
                });

                // Find dependencies (skills that reference each other)
                const refs = content.match(/skill[s]?[:\s]+["']?([a-z-]+)["']?/gi) || [];
                for (const ref of refs) {
                    const targetName = ref.replace(/skill[s]?[:\s]+["']?/i, '').replace(/["']$/, '');
                    const targetIdx = skillEntries.findIndex(entry => entry.dir.name.toLowerCase().includes(targetName.toLowerCase()));
                    if (targetIdx >= 0 && targetIdx !== i) {
                        links.push({ source: `skill:${source}:${dir.name}`, target: `skill:${skillEntries[targetIdx].source}:${skillEntries[targetIdx].dir.name}`, type: 'references', value: 3 });
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
            totalCommands: 0,
            categories: uniqueCategories,
            sources: [...new Set(nodes.map(node => node.source))].sort(),
            consolidationCount: 0,
            frameworkCopyGroups: 0,
            usedSkills: nodes.filter(node => node.usage > 0).length,
            unusedSkills: nodes.filter(node => node.usage === 0).length,
            triedSkills: skillState.triedSkills.length,
            untriedSkills: nodes.filter(node => !node.tried).length
        };

        const recommendedUnused = nodes
            .filter(node => node.usage === 0 && !node.tried)
            .map(node => ({
                id: node.id,
                name: node.name,
                title: node.title,
                description: node.description,
                source: node.source,
                category: node.category,
                score: 70 + (node.description ? 10 : 0) + Math.min(Math.round((node.contentLength || 0) / 5000), 12),
                reasons: ['No observed usage yet', 'Available in this project', node.description ? 'Has a description' : 'Worth reviewing'],
                copyCount: 1,
                hasCommand: false,
                tried: false
            }))
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
            .slice(0, 18);

        res.json({
            nodes,
            links,
            stats,
            insights: {
                topUsed: [],
                recommendedUnused,
                unused: nodes.filter(node => node.usage === 0).slice(0, 20),
                consolidation: [],
                frameworkCopies: [],
                triedSkills: skillState.triedSkills,
                usageSource: 'Claude analytics plus Watchpost tried state',
                usageScannedFiles: 0
            },
            triedSkills: skillState.triedSkills
        });
    } catch (err) {
        res.json({ nodes: [], links: [], stats: { totalSkills: 0, categories: [] }, error: err.message });
    }
});

app.get('/api/skills/tried', (_req, res) => {
    res.json(readSkillState());
});

app.post('/api/skills/tried', (req, res) => {
    const item = markSkillTried(req.body?.name || req.body?.skillName, req.body?.source || 'manual');
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
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
    const docsDir = path.join(projectRoot, 'docs');

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
                            color: '#6b7280',
                            contentLength: content.length
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

// GET /api/docs/content - Return raw markdown content of a doc file
app.get('/api/docs/content', (req, res) => {
    const relPath = req.query.path;
    if (!relPath) {
        return res.status(400).json({ error: 'Missing path parameter' });
    }
    // Sanitize: no directory traversal
    if (relPath.includes('..') || path.isAbsolute(relPath)) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
    const docsDir = path.join(projectRoot, 'docs');
    const fullPath = path.join(docsDir, relPath);

    // Ensure resolved path is within docs dir
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(docsDir))) {
        return res.status(400).json({ error: 'Path outside docs directory' });
    }

    try {
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'File not found' });
        }
        const content = fs.readFileSync(resolved, 'utf8');
        res.json({ content, path: relPath });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/skills/content - Return raw SKILL.md content
app.get('/api/skills/content', (req, res) => {
    const skillName = req.query.name;
    if (!skillName) {
        return res.status(400).json({ error: 'Missing name parameter' });
    }
    // Sanitize: no directory traversal, only alphanumeric + hyphens + underscores
    if (skillName.includes('..') || skillName.includes('/') || skillName.includes('\\')) {
        return res.status(400).json({ error: 'Invalid skill name' });
    }

    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
    const skillPath = path.join(projectRoot, '.claude/skills', skillName, 'SKILL.md');

    // Ensure resolved path is within skills dir
    const resolved = path.resolve(skillPath);
    const skillsDir = path.resolve(path.join(projectRoot, '.claude/skills'));
    if (!resolved.startsWith(skillsDir)) {
        return res.status(400).json({ error: 'Path outside skills directory' });
    }

    try {
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'Skill not found' });
        }
        const content = fs.readFileSync(resolved, 'utf8');
        res.json({ content, name: skillName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/skills/analytics - Real usage analytics from conversation logs
app.get('/api/skills/analytics', (req, res) => {
    const skillName = req.query.name;
    if (!skillName || skillName.includes('..') || skillName.includes('/')) {
        return res.status(400).json({ error: 'Invalid skill name' });
    }

    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
    const homeDir = process.env.HOME || '/home/endlessblink';

    try {
        // 1. File metadata
        const skillDir = path.join(projectRoot, '.claude/skills', skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');
        let fileMeta = null;
        if (fs.existsSync(skillFile)) {
            const stat = fs.statSync(skillFile);
            fileMeta = {
                size: stat.size,
                created: stat.birthtime,
                modified: stat.mtime,
                sizeKB: Math.round(stat.size / 1024 * 10) / 10
            };
        }

        // 2. Scan conversation logs for skill invocations
        const projSlug = projectRoot.replace(/\//g, '-');
        const sessionsDir = path.join(homeDir, '.claude/projects', projSlug);
        let invocations = 0;
        let invocationDates = [];
        let fileReads = 0;
        let fileReadDates = [];
        let agentDelegations = 0;
        let agentBreakdown = {};
        let lastInvoked = null;

        // Clean skill name for matching (strip emoji prefix + spaces)
        const cleanName = skillName.replace(/^[^a-zA-Z0-9_-]+/, '').toLowerCase();
        // Also try matching without hyphens (e.g. "dev-debugging" matches "dev-debugging" or "devdebugging")
        const nameVariants = [cleanName, cleanName.replace(/-/g, '')].filter(Boolean);

        if (fs.existsSync(sessionsDir)) {
            const sessionFiles = fs.readdirSync(sessionsDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, path: path.join(sessionsDir, f), mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 500); // Last 500 sessions

            for (const sf of sessionFiles) {
                try {
                    const content = fs.readFileSync(sf.path, 'utf8');

                    // Count skill invocations (Skill tool calls)
                    for (const variant of nameVariants) {
                        const escaped = variant.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
                        const skillMatches = content.match(new RegExp(`"skill":"[^"]*${escaped}[^"]*"`, 'gi'));
                        if (skillMatches) {
                            invocations += skillMatches.length;
                            invocationDates.push(sf.mtime);
                            break; // Don't double-count
                        }
                    }

                    // Count SKILL.md file reads - try both emoji and clean name patterns
                    const readPatterns = [
                        new RegExp(`skills/${skillName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}/SKILL\\.md`, 'g'),
                        new RegExp(`skills/[^/]*${cleanName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}[^/]*/SKILL\\.md`, 'gi')
                    ];
                    for (const readPattern of readPatterns) {
                        const readMatches = content.match(readPattern);
                        if (readMatches) {
                            fileReads += readMatches.length;
                            fileReadDates.push(sf.mtime);
                            break; // Don't double count
                        }
                    }

                    // Count agent delegations mentioning this skill + track agent types
                    const agentPattern = new RegExp(`${cleanName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}`, 'gi');
                    const delegationSection = content.match(/"subagent_type"[^}]*}/g);
                    if (delegationSection) {
                        for (const d of delegationSection) {
                            if (agentPattern.test(d)) {
                                agentDelegations++;
                                const agentMatch = d.match(/"subagent_type"\s*:\s*"([^"]+)"/);
                                if (agentMatch) {
                                    const agentType = agentMatch[1];
                                    agentBreakdown[agentType] = (agentBreakdown[agentType] || 0) + 1;
                                }
                            }
                        }
                    }

                    // Also scan for agent types near skill invocations
                    const lines = content.split('\n');
                    for (let li = 0; li < lines.length; li++) {
                        const line = lines[li];
                        if (agentPattern.test(line)) {
                            // Check nearby lines (within 5 lines) for subagent_type
                            for (let offset = -5; offset <= 5; offset++) {
                                const nearby = lines[li + offset];
                                if (nearby) {
                                    const agentMatch = nearby.match(/"subagent_type"\s*:\s*"([^"]+)"/);
                                    if (agentMatch && !delegationSection) {
                                        const agentType = agentMatch[1];
                                        agentBreakdown[agentType] = (agentBreakdown[agentType] || 0) + 1;
                                    }
                                }
                            }
                            agentPattern.lastIndex = 0; // Reset regex state
                        }
                    }
                } catch (e) { /* skip unreadable files */ }
            }
        }

        // Sort and deduplicate dates
        invocationDates.sort((a, b) => a - b);
        if (invocationDates.length > 0) {
            lastInvoked = new Date(invocationDates[invocationDates.length - 1]);
        }

        // 3. Build daily activity for last 90 days (from both invocations and file reads)
        const now = Date.now();
        const dayMs = 86400000;
        const activityDays = 90;
        const dailyActivity = new Array(activityDays).fill(0);
        const allDates = [...invocationDates, ...fileReadDates];
        allDates.forEach(ts => {
            const daysAgo = Math.floor((now - ts) / dayMs);
            if (daysAgo >= 0 && daysAgo < activityDays) {
                dailyActivity[activityDays - 1 - daysAgo]++;
            }
        });

        // 4. Complexity assessment
        let complexity = 'simple';
        if (fileMeta) {
            if (fileMeta.size > 30000) complexity = 'comprehensive';
            else if (fileMeta.size > 15000) complexity = 'detailed';
            else if (fileMeta.size > 5000) complexity = 'moderate';
        }

        // Build recent sessions list (unique dates, most recent first)
        const recentSessionDates = [...new Set(allDates.map(ts => new Date(ts).toISOString().split('T')[0]))]
            .sort((a, b) => b.localeCompare(a))
            .slice(0, 5);

        res.json({
            name: skillName,
            fileMeta,
            usage: {
                invocations,
                fileReads,
                agentDelegations,
                totalInteractions: invocations + fileReads,
                lastInvoked,
                complexity,
                agentBreakdown: Object.entries(agentBreakdown)
                    .map(([agent, count]) => ({ agent, count }))
                    .sort((a, b) => b.count - a.count)
            },
            recentSessions: recentSessionDates,
            activity: {
                days: activityDays,
                daily: dailyActivity,
                activeDays: dailyActivity.filter(d => d > 0).length,
                peakDay: Math.max(...dailyActivity),
                sessionsScanned: 200
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/docs/analytics - Real usage analytics for docs
app.get('/api/docs/analytics', (req, res) => {
    const docPath = req.query.path;
    if (!docPath || docPath.includes('..')) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
    const homeDir = process.env.HOME || '/home/endlessblink';

    try {
        // 1. File metadata
        const fullPath = path.join(projectRoot, 'docs', docPath);
        let fileMeta = null;
        if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            fileMeta = {
                size: stat.size,
                created: stat.birthtime,
                modified: stat.mtime,
                sizeKB: Math.round(stat.size / 1024 * 10) / 10
            };
        }

        // 2. Scan conversation logs for doc reads
        const projSlug = projectRoot.replace(/\//g, '-');
        const sessionsDir = path.join(homeDir, '.claude/projects', projSlug);
        let fileReads = 0;
        let readDates = [];
        let agentBreakdown = {};

        const searchPath = 'docs/' + docPath;

        if (fs.existsSync(sessionsDir)) {
            const sessionFiles = fs.readdirSync(sessionsDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => ({ name: f, path: path.join(sessionsDir, f), mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 500);

            for (const sf of sessionFiles) {
                try {
                    const content = fs.readFileSync(sf.path, 'utf8');
                    const pattern = new RegExp(searchPath.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'g');
                    const matches = content.match(pattern);
                    if (matches) {
                        fileReads += matches.length;
                        readDates.push(sf.mtime);

                        // Track which agents read this doc
                        const lines = content.split('\n');
                        const docPatternLocal = new RegExp(searchPath.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
                        for (let li = 0; li < lines.length; li++) {
                            if (docPatternLocal.test(lines[li])) {
                                // Check nearby lines for subagent_type
                                for (let offset = -5; offset <= 5; offset++) {
                                    const nearby = lines[li + offset];
                                    if (nearby) {
                                        const agentMatch = nearby.match(/"subagent_type"\s*:\s*"([^"]+)"/);
                                        if (agentMatch) {
                                            const agentType = agentMatch[1];
                                            agentBreakdown[agentType] = (agentBreakdown[agentType] || 0) + 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        readDates.sort((a, b) => a - b);

        // 3. Daily activity (90 days)
        const now = Date.now();
        const dayMs = 86400000;
        const activityDays = 90;
        const dailyActivity = new Array(activityDays).fill(0);
        readDates.forEach(ts => {
            const daysAgo = Math.floor((now - ts) / dayMs);
            if (daysAgo >= 0 && daysAgo < activityDays) {
                dailyActivity[activityDays - 1 - daysAgo]++;
            }
        });

        // Build recent sessions list (unique dates, most recent first)
        const recentSessionDates = [...new Set(readDates.map(ts => new Date(ts).toISOString().split('T')[0]))]
            .sort((a, b) => b.localeCompare(a))
            .slice(0, 5);

        res.json({
            path: docPath,
            fileMeta,
            usage: {
                fileReads,
                lastRead: readDates.length > 0 ? new Date(readDates[readDates.length - 1]) : null,
                agentBreakdown: Object.entries(agentBreakdown)
                    .map(([agent, count]) => ({ agent, count }))
                    .sort((a, b) => b.count - a.count)
            },
            recentSessions: recentSessionDates,
            activity: {
                days: activityDays,
                daily: dailyActivity,
                activeDays: dailyActivity.filter(d => d > 0).length,
                peakDay: Math.max(...dailyActivity),
                sessionsScanned: 200
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============== BEADS API ==============
const { spawn } = require('child_process');
const BD_PATH = process.env.BD_PATH || (() => {
    // Try common Go bin locations
    const candidates = [
        `${process.env.HOME}/app-data/go/bin/bd`,
        `${process.env.HOME}/go/bin/bd`,
        '/usr/local/bin/bd'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return 'bd'; // fallback to PATH
})();

// Track running agents
const runningAgents = new Map(); // id -> { process, task, startTime, outputBuffer, clients }

// SSE clients for agent output
const agentOutputClients = new Map(); // agentId -> [res, res, ...]

// Helper to run bd commands
const runBd = (args) => {
    try {
        const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
        const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
        const result = execSync(`${BD_PATH} ${args} --json`, {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 10000
        });
        return JSON.parse(result);
    } catch (err) {
        console.error(`[Beads] Error running bd ${args}:`, err.message);
        return null;
    }
};

function mapNativeTaskStatus(status) {
    if (status === 'done') return 'closed';
    if (status === 'planned') return 'open';
    return status;
}

function mapNativeTaskToIssue(task) {
    const prefix = task.id?.match(/^([A-Z][A-Z0-9]*)-/)?.[1]?.toLowerCase() || 'task';
    return {
        ...task,
        status: mapNativeTaskStatus(task.status),
        issue_type: prefix,
        external_ref: task.id,
        dependency_count: 0,
        dependent_count: 0
    };
}

function getNativeTaskFilter(status) {
    if (!status) return { status: undefined, excludeDone: true };
    if (status === 'closed') return { status: 'done', excludeDone: false };
    if (status === 'open') return { status: 'planned', excludeDone: false };
    return { status, excludeDone: false };
}

function getNativeIssues(status) {
    const filter = getNativeTaskFilter(status);
    const tasks = taskEngine.getTasks(filter.status ? { status: filter.status } : undefined);
    return (filter.excludeDone ? tasks.filter(task => task.status !== 'done') : tasks).map(mapNativeTaskToIssue);
}

// GET /api/beads/stats - Project statistics
app.get('/api/beads/stats', (req, res) => {
    if (taskEngineReady) {
        const tasks = taskEngine.getTasks();
        const ready = taskEngine.getReady().length;
        const inProgress = tasks.filter(t => t.status === 'in_progress').length;
        const blocked = taskEngine.getBlocked().length;
        const done = tasks.filter(t => t.status === 'done').length;
        return res.json({
            summary: {
                total_issues: tasks.length,
                ready_issues: ready,
                in_progress_issues: inProgress,
                blocked_issues: blocked,
                closed_issues: done
            }
        });
    }
    const stats = runBd('stats');
    res.json(stats || { error: 'Failed to fetch stats' });
});

// GET /api/beads/list - All issues (supports ?status=open,in_progress,closed,blocked)
app.get('/api/beads/list', (req, res) => {
    const status = req.query.status;
    if (taskEngineReady) {
        return res.json({ issues: getNativeIssues(status), error: null });
    }
    const args = status ? `list --limit 0 --status=${status}` : 'list --limit 0';
    const issues = runBd(args);
    res.json({ issues: issues || [], error: issues ? null : 'Failed to fetch issues' });
});

// GET /api/beads/ready - Ready issues (unblocked)
app.get('/api/beads/ready', (req, res) => {
    if (taskEngineReady) {
        return res.json({ issues: taskEngine.getReady().map(mapNativeTaskToIssue), error: null });
    }
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
    if (taskEngineReady) {
        const graph = taskEngine.getGraph();
        return res.json({
            nodes: graph.nodes.map(task => ({
                id: task.id,
                title: task.title,
                status: mapNativeTaskStatus(task.status),
                priority: task.priority,
                lane: task.lane,
                type: task.id?.match(/^([A-Z][A-Z0-9]*)-/)?.[1]?.toLowerCase() || 'task',
                dependencyCount: 0,
                dependentCount: 0
            })),
            links: graph.links
        });
    }
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

// Helper: Respawn a failed agent with exponential backoff (TASK-322)
function respawnAgent(taskId, agentData) {
    console.log(`[Agent] Respawning agent for task ${taskId} (attempt ${agentData.retryCount}/${agentData.maxRetries})`);

    // Build retry prompt with context from previous attempt
    const lastLines = agentData.outputBuffer
        .slice(-50)
        .map(l => l.text || l.message || '')
        .filter(Boolean)
        .join('\n');

    const retryPrompt = `You are resuming work on task ${taskId}. A previous attempt failed.
The worktree may contain partial progress from the previous attempt.
Check git status and git log to see what was already done before continuing.
Original task: ${agentData.task.title || agentData.task.description || 'No title'}

Previous attempt output (last 50 lines):
${lastLines}

Continue from where the previous attempt left off. Do not restart from scratch.`;

    // Spawn new claude process in the SAME worktree (preserves partial progress)
    const newProcess = spawn(CLAUDE_BINARY, [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--max-turns', '50',
        '-p', retryPrompt
    ], {
        cwd: agentData.worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    // Update agent data with new process
    agentData.process = newProcess;
    agentData.status = 'running';
    agentData.startTime = Date.now();
    agentData.jsonBuffer = '';

    broadcastAgentOutput(taskId, {
        type: 'system',
        message: `Retry ${agentData.retryCount}/${agentData.maxRetries} started`
    });

    // Re-attach stdout handler using shared parsing function
    newProcess.stdout.on('data', (data) => {
        agentData.jsonBuffer = parseAndBroadcastAgentOutput(
            taskId,
            data.toString(),
            agentData,
            agentData.jsonBuffer || ''
        );
    });

    // Re-attach stderr handler
    newProcess.stderr.on('data', (data) => {
        const output = data.toString();
        agentData.outputBuffer.push({ type: 'stderr', text: output, time: Date.now() });
        broadcastAgentOutput(taskId, { type: 'stderr', text: output });
    });

    // Re-attach close handler (recursive — will retry again if needed)
    newProcess.on('close', (code) => {
        handleAgentClose(taskId, agentData, code);
    });

    newProcess.on('error', (err) => {
        console.error(`[Agent] Error respawning agent for ${taskId}:`, err.message);
        agentData.status = 'error';
        agentData.lastError = err.message;
        broadcastAgentOutput(taskId, { type: 'error', message: err.message });
    });
}

// Helper: Handle agent process close with retry logic (TASK-322)
function handleAgentClose(taskId, agentData, code) {
    console.log(`[Agent] Task ${taskId} agent exited with code ${code}`);
    agentData.exitCode = code;
    agentData.endTime = Date.now();

    // Persist output to disk
    const logDir = path.join(__dirname, 'agent-logs');
    try {
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
            path.join(logDir, `${taskId}-${Date.now()}.jsonl`),
            agentData.outputBuffer.map(l => JSON.stringify(l)).join('\n'),
            'utf8'
        );
    } catch (logErr) {
        console.error(`[Agent] Failed to persist log for ${taskId}:`, logErr.message);
    }

    if (code === 0) {
        agentData.status = 'completed';
        broadcastAgentOutput(taskId, {
            type: 'exit',
            code: code,
            message: 'Task completed successfully'
        });
    } else if (agentData.retryCount < agentData.maxRetries) {
        const delay = Math.pow(2, agentData.retryCount) * 1000; // 1s, 2s, 4s
        agentData.retryCount++;
        agentData.lastError = `Exit code ${code}`;
        agentData.status = 'retrying';
        broadcastAgentOutput(taskId, {
            type: 'system',
            message: `Agent failed (exit ${code}). Retry ${agentData.retryCount}/${agentData.maxRetries} in ${delay / 1000}s...`
        });
        setTimeout(() => respawnAgent(taskId, agentData), delay);
    } else {
        agentData.status = 'failed';
        agentData.lastError = `Exit code ${code} after ${agentData.maxRetries} retries`;
        // Auto-revert beads status to todo so task can be re-claimed
        const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
        const projectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
        try {
            execSync(`${BD_PATH} update ${taskId} --status todo`, { cwd: projectRoot, timeout: 5000 });
        } catch (e) { /* best effort */ }
        broadcastAgentOutput(taskId, {
            type: 'system',
            message: `Agent failed after ${agentData.maxRetries} retries. Task reverted to todo.`
        });
    }

    // Clean up after a delay (keep for logs viewing) — only if not retrying
    if (agentData.status !== 'retrying') {
        setTimeout(() => {
            if (runningAgents.get(taskId)?.status !== 'running') {
                runningAgents.delete(taskId);
            }
        }, 300000); // 5 minutes
    }
}

// Helper: Clean up ALL stale worktrees (older than maxAgeHours)
// BUG-1113: Prevents context bloat in Claude Code
function cleanupStaleWorktrees(maxAgeHours = 24, customProjectRoot = null) {
    // Use provided projectRoot, or derive from MASTER_PLAN_PATH, or fallback to parent dir
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = customProjectRoot || (masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..'));
    const worktreesDir = path.join(projectRoot, '.agent-worktrees');
    const results = { cleaned: [], failed: [], skipped: [] };

    try {
        if (!fs.existsSync(worktreesDir)) {
            console.log('[Cleanup] No .agent-worktrees directory found');
            return results;
        }

        const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
        const now = Date.now();
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const worktreePath = path.join(worktreesDir, entry.name);

            try {
                const stats = fs.statSync(worktreePath);
                const ageMs = now - stats.mtimeMs;
                const ageHours = Math.round(ageMs / (60 * 60 * 1000));

                if (ageMs > maxAgeMs) {
                    // Remove the worktree via git
                    try {
                        execSync(`git worktree remove "${worktreePath}" --force`, {
                            cwd: projectRoot,
                            encoding: 'utf8',
                            stdio: 'pipe'
                        });
                        results.cleaned.push({ name: entry.name, ageHours });
                        console.log(`[Cleanup] Removed stale worktree: ${entry.name} (${ageHours}h old)`);
                    } catch (gitErr) {
                        // If git worktree remove fails, try direct removal
                        try {
                            fs.rmSync(worktreePath, { recursive: true, force: true });
                            results.cleaned.push({ name: entry.name, ageHours, method: 'direct' });
                            console.log(`[Cleanup] Force-removed stale worktree: ${entry.name}`);
                        } catch (rmErr) {
                            results.failed.push({ name: entry.name, error: rmErr.message });
                            console.error(`[Cleanup] Failed to remove ${entry.name}: ${rmErr.message}`);
                        }
                    }
                } else {
                    results.skipped.push({ name: entry.name, ageHours });
                }
            } catch (statErr) {
                results.failed.push({ name: entry.name, error: statErr.message });
            }
        }

        // Prune git's worktree list to remove stale entries
        try {
            execSync('git worktree prune', { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
            console.log('[Cleanup] Pruned git worktree list');
        } catch (pruneErr) {
            console.warn('[Cleanup] Could not prune worktree list:', pruneErr.message);
        }

        // Also clean up orphaned branches (bd-* branches without worktrees)
        try {
            const branches = execSync('git branch', { cwd: projectRoot, encoding: 'utf8' })
                .split('\n')
                .map(b => b.trim().replace('* ', ''))
                .filter(b => b.startsWith('bd-'));

            for (const branch of branches) {
                // Check if corresponding worktree exists
                const taskId = branch.replace('bd-', '');
                const worktreePath = path.join(worktreesDir, taskId);
                const orchWorktreePath = path.join(worktreesDir, `orch-${taskId}`);

                if (!fs.existsSync(worktreePath) && !fs.existsSync(orchWorktreePath)) {
                    try {
                        execSync(`git branch -D ${branch}`, { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
                        console.log(`[Cleanup] Deleted orphaned branch: ${branch}`);
                    } catch (branchErr) {
                        // Ignore branch deletion errors
                    }
                }
            }
        } catch (branchListErr) {
            // Ignore branch listing errors
        }

        console.log(`[Cleanup] Summary: ${results.cleaned.length} cleaned, ${results.skipped.length} skipped, ${results.failed.length} failed`);
        return results;
    } catch (err) {
        console.error('[Cleanup] Error during stale worktree cleanup:', err.message);
        return results;
    }
}

// GET /api/cleanup-worktrees - Manual worktree cleanup endpoint
// BUG-1113: Allows manual trigger of stale worktree cleanup
app.get('/api/cleanup-worktrees', (req, res) => {
    const maxAgeHours = parseInt(req.query.maxAgeHours) || 24;
    const customProjectRoot = req.query.projectRoot || null;
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = customProjectRoot || (masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..'));

    const results = cleanupStaleWorktrees(maxAgeHours, customProjectRoot);
    res.json({
        success: true,
        maxAgeHours,
        projectRoot,
        worktreesDir: path.join(projectRoot, '.agent-worktrees'),
        ...results
    });
});

// POST /api/cleanup-worktrees - Force cleanup all worktrees (maxAge=0)
app.post('/api/cleanup-worktrees', (req, res) => {
    const { maxAgeHours = 0, force = false, projectRoot: customProjectRoot = null } = req.body;
    const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
    const projectRoot = customProjectRoot || (masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..'));

    if (force) {
        // Force cleanup: remove ALL worktrees regardless of age
        const results = cleanupStaleWorktrees(0, customProjectRoot);
        res.json({
            success: true,
            forced: true,
            projectRoot,
            worktreesDir: path.join(projectRoot, '.agent-worktrees'),
            ...results
        });
    } else {
        const results = cleanupStaleWorktrees(maxAgeHours, customProjectRoot);
        res.json({
            success: true,
            maxAgeHours,
            projectRoot,
            worktreesDir: path.join(projectRoot, '.agent-worktrees'),
            ...results
        });
    }
});

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
                status: 'running',
                retryCount: 0,
                maxRetries: 3,
                lastError: null
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

            // Handle exit — delegates to handleAgentClose for retry logic (TASK-322)
            agentProcess.on('close', (code) => {
                handleAgentClose(taskId, agentData, code);
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

// GET /api/beads/agents/:id/retries - Get retry info for an agent (TASK-322)
app.get('/api/beads/agents/:id/retries', (req, res) => {
    const agent = runningAgents.get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({
        taskId: agent.taskId,
        retryCount: agent.retryCount || 0,
        maxRetries: agent.maxRetries || 3,
        lastError: agent.lastError || null,
        status: agent.status
    });
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

// ============================================================================
// HAPPY CODER INTEGRATION - Remote Claude Code control via mobile
// ============================================================================

const { getHappyManager } = require('./modules/happy-manager');
const { getHappySafety } = require('./modules/happy-safety');

// Initialize Happy modules
const happyManager = getHappyManager({ dataDir: path.join(__dirname, 'data') });
const happySafety = getHappySafety({
    configDir: path.join(__dirname, 'local'),
    dataDir: path.join(__dirname, 'data')
});

// SSE clients specifically for Happy updates
let happyClients = [];

// Helper to broadcast Happy events
const broadcastHappyEvent = (event) => {
    const payload = JSON.stringify(event);
    happyClients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
    });
    // Also send to main event stream
    clients.forEach(client => {
        client.write(`data: ${payload}\n\n`);
    });
};

// Wire up Happy manager events
happyManager.on('session-started', (data) => {
    broadcastHappyEvent({ type: 'happy-session-started', ...data });
    console.log(`[Happy] Session started: ${data.sessionId}`);
});

happyManager.on('session-stopped', (data) => {
    broadcastHappyEvent({ type: 'happy-session-stopped', ...data });
    console.log(`[Happy] Session stopped: ${data.sessionId}`);
});

happyManager.on('session-connected', (data) => {
    broadcastHappyEvent({ type: 'happy-session-connected', ...data });
    console.log(`[Happy] Session connected: ${data.sessionId}`);
});

happyManager.on('session-qr-ready', (data) => {
    broadcastHappyEvent({ type: 'happy-qr-ready', ...data });
    console.log(`[Happy] QR ready for session: ${data.sessionId}`);
});

happyManager.on('session-error', (data) => {
    broadcastHappyEvent({ type: 'happy-session-error', ...data });
    console.error(`[Happy] Session error: ${data.sessionId} - ${data.error}`);
});

// Wire up Happy safety events
happySafety.on('command-queued', (data) => {
    broadcastHappyEvent({ type: 'happy-command-queued', ...data });
    console.log(`[Happy] Command queued for approval: ${data.id}`);
});

happySafety.on('command-approved', (data) => {
    broadcastHappyEvent({ type: 'happy-command-approved', ...data });
    console.log(`[Happy] Command approved: ${data.id}`);
});

happySafety.on('command-denied', (data) => {
    broadcastHappyEvent({ type: 'happy-command-denied', ...data });
    console.log(`[Happy] Command denied: ${data.id}`);
});

// GET /api/happy/status - Check Happy CLI installation status
app.get('/api/happy/status', async (req, res) => {
    try {
        const installation = await happyManager.checkInstallation();
        const safetyStatus = happySafety.getStatus();

        res.json({
            happy: installation,
            safety: safetyStatus,
            activeSessions: happyManager.getSessions().filter(s =>
                s.status === 'running' || s.status === 'connected' || s.status === 'awaiting-pairing'
            ).length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/happy/sessions - List all Happy sessions
app.get('/api/happy/sessions', (req, res) => {
    try {
        const sessions = happyManager.getSessions();
        res.json({ sessions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/happy/start - Start a new Happy session
app.post('/api/happy/start', async (req, res) => {
    try {
        const { projectPath, model, permissionMode, env } = req.body;

        // Check if Happy is installed
        const installation = await happyManager.checkInstallation();
        if (!installation.installed) {
            return res.status(400).json({
                error: 'Happy CLI not installed',
                installCommand: 'npm install -g happy-coder'
            });
        }

        // Start the session
        const session = await happyManager.startSession({
            projectPath: projectPath || process.env.MASTER_PLAN_PATH?.replace('/docs/MASTER_PLAN.md', '') || process.cwd(),
            model: model || 'sonnet',
            permissionMode: permissionMode || 'default',
            env
        });

        res.json(session);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/happy/stop/:id - Stop a Happy session
app.post('/api/happy/stop/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { force } = req.body;

        const result = happyManager.stopSession(id, force === true);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/happy/session/:id - Get session details
app.get('/api/happy/session/:id', (req, res) => {
    try {
        const { id } = req.params;
        const session = happyManager.getSession(id);

        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        res.json(session);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/happy/session/:id/output - Get session output
app.get('/api/happy/session/:id/output', (req, res) => {
    try {
        const { id } = req.params;
        const lines = parseInt(req.query.lines) || 100;

        const output = happyManager.getSessionOutput(id, lines);
        res.json({ output });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/happy/stream/:id - SSE stream for session output
app.get('/api/happy/stream/:id', (req, res) => {
    const { id } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial state
    const session = happyManager.getSession(id);
    if (!session) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Session not found' })}\n\n`);
        return res.end();
    }

    res.write(`data: ${JSON.stringify({ type: 'session', session })}\n\n`);

    // Handler for session output
    const outputHandler = (data) => {
        if (data.sessionId === id) {
            res.write(`data: ${JSON.stringify({ type: 'output', ...data })}\n\n`);
        }
    };

    // Handler for session stop
    const stopHandler = (data) => {
        if (data.sessionId === id) {
            res.write(`data: ${JSON.stringify({ type: 'stopped', ...data })}\n\n`);
            cleanup();
            res.end();
        }
    };

    happyManager.on('session-output', outputHandler);
    happyManager.on('session-stopped', stopHandler);

    const cleanup = () => {
        happyManager.off('session-output', outputHandler);
        happyManager.off('session-stopped', stopHandler);
    };

    // Keep alive
    const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
    }, 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        cleanup();
    });
});

// GET /api/happy/queue - Get pending command approvals
app.get('/api/happy/queue', (req, res) => {
    try {
        const pending = happySafety.getPendingCommands();
        res.json({ pending, count: pending.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/happy/queue/:id/approve - Approve a queued command
app.post('/api/happy/queue/:id/approve', (req, res) => {
    try {
        const { id } = req.params;
        const { approvedBy } = req.body;

        const result = happySafety.approveCommand(id, approvedBy || 'dashboard');
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/happy/queue/:id/deny - Deny a queued command
app.post('/api/happy/queue/:id/deny', (req, res) => {
    try {
        const { id } = req.params;
        const { deniedBy, reason } = req.body;

        const result = happySafety.denyCommand(id, deniedBy || 'dashboard', reason || '');
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/happy/queue/stream - SSE stream for command queue updates
app.get('/api/happy/queue/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send current queue
    const pending = happySafety.getPendingCommands();
    res.write(`data: ${JSON.stringify({ type: 'queue', pending })}\n\n`);

    // Add to Happy SSE clients
    happyClients.push(res);

    const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
    }, 15000);

    req.on('close', () => {
        clearInterval(keepAlive);
        happyClients = happyClients.filter(c => c !== res);
    });
});

// GET /api/happy/audit - Get audit log entries
app.get('/api/happy/audit', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const sessionId = req.query.sessionId;
        const status = req.query.status;

        const entries = happySafety.readAuditLog({ limit, sessionId, status });
        res.json({ entries, count: entries.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/happy/config - Get safety configuration
app.get('/api/happy/config', (req, res) => {
    try {
        const config = happySafety.getConfig();
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/happy/config - Update safety configuration
app.post('/api/happy/config', (req, res) => {
    try {
        const updates = req.body;
        happySafety.updateConfig(updates);
        res.json({ success: true, config: happySafety.getConfig() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/happy/check - Check if a command is allowed (for testing)
app.post('/api/happy/check', async (req, res) => {
    try {
        const { command, sessionId, source, type } = req.body;

        if (!command) {
            return res.status(400).json({ error: 'Command is required' });
        }

        const result = await happySafety.checkCommand({
            command,
            sessionId: sessionId || 'test',
            source: source || 'api',
            type: type || 'unknown'
        });

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/happy/events - SSE stream for all Happy events
app.get('/api/happy/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    happyClients.push(res);
    console.log(`[Happy] SSE client connected. (Total: ${happyClients.length})`);

    const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
    }, 15000);

    req.on('close', () => {
        console.log(`[Happy] SSE client disconnected.`);
        clearInterval(keepAlive);
        happyClients = happyClients.filter(c => c !== res);
    });
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

// ============================================================================
// NATIVE TASK ENGINE API (/api/tasks/*)
// ============================================================================

// Middleware: check task engine is ready
const requireTaskEngine = (req, res, next) => {
    if (!taskEngineReady) {
        return res.status(503).json({ error: 'Task engine not initialized. Set MASTER_PLAN_PATH first.' });
    }
    next();
};

// GET /api/tasks/stats - Task statistics
app.get('/api/tasks/stats', requireTaskEngine, (req, res) => {
    try {
        res.json(taskEngine.getStats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/tasks/list - All tasks (optional ?status=X&priority=X)
app.get('/api/tasks/list', requireTaskEngine, (req, res) => {
    try {
        const filters = {};
        if (req.query.status) filters.status = req.query.status;
        if (req.query.priority) filters.priority = req.query.priority;
        const tasks = taskEngine.getTasks(Object.keys(filters).length ? filters : undefined);
        res.json({ tasks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/tasks/ready - Tasks with all deps resolved
app.get('/api/tasks/ready', requireTaskEngine, (req, res) => {
    try {
        res.json({ tasks: taskEngine.getReady() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/tasks/blocked - Tasks with unresolved deps
app.get('/api/tasks/blocked', requireTaskEngine, (req, res) => {
    try {
        res.json({ tasks: taskEngine.getBlocked() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/tasks/:id/deps - Task details with dependencies
app.get('/api/tasks/:id/deps', requireTaskEngine, (req, res) => {
    try {
        const task = taskEngine.getTask(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        res.json(task);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/tasks/graph - Full dependency graph for D3
app.get('/api/tasks/graph', requireTaskEngine, (req, res) => {
    try {
        res.json(taskEngine.getGraph());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tasks/:id/claim - Set task to in_progress
app.post('/api/tasks/:id/claim', requireTaskEngine, (req, res) => {
    try {
        const id = req.params.id;
        const result = taskEngine.updateStatus(id, 'in_progress');
        if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
        // Write back to markdown
        const masterPlanPath = getMasterPlanPath();
        taskEngine.writeBackStatus(masterPlanPath, id, 'in_progress');
        res.json({ success: true, id, status: 'in_progress' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tasks/:id/close - Set task to done
app.post('/api/tasks/:id/close', requireTaskEngine, (req, res) => {
    try {
        const id = req.params.id;
        const result = taskEngine.updateStatus(id, 'done');
        if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
        // Write back to markdown
        const masterPlanPath = getMasterPlanPath();
        taskEngine.writeBackStatus(masterPlanPath, id, 'done');
        res.json({ success: true, id, status: 'done' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tasks/sync - Re-sync from MASTER_PLAN.md
app.post('/api/tasks/sync', requireTaskEngine, (req, res) => {
    try {
        const masterPlanPath = getMasterPlanPath();
        const count = taskEngine.syncFromMarkdown(masterPlanPath);
        res.json({ success: true, synced: count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// CHANGELOG API — Agent action audit trail
// ============================================================================

// GET /api/changelog/actions - Query actions with filters
app.get('/api/changelog/actions', (req, res) => {
  try {
    const actions = changelogEngine.queryActions({
      project: req.query.project,
      session: req.query.session,
      tool: req.query.tool,
      file: req.query.file,
      since: req.query.since,
      until: req.query.until,
      limit: parseInt(req.query.limit) || 100,
      offset: parseInt(req.query.offset) || 0
    });
    res.json({ success: true, count: actions.length, actions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/changelog/sessions - List sessions
app.get('/api/changelog/sessions', (req, res) => {
  try {
    const sessions = changelogEngine.querySessions({
      project: req.query.project,
      limit: parseInt(req.query.limit) || 20
    });
    res.json({ success: true, count: sessions.length, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/changelog/file-history - All changes to a file
app.get('/api/changelog/file-history', (req, res) => {
  try {
    if (!req.query.file) return res.status(400).json({ error: 'file parameter required' });
    const history = changelogEngine.queryFileHistory({
      file: req.query.file,
      project: req.query.project,
      limit: parseInt(req.query.limit) || 50
    });
    res.json({ success: true, count: history.length, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/changelog/stats - Action statistics
app.get('/api/changelog/stats', (req, res) => {
  try {
    const stats = changelogEngine.queryStats({
      project: req.query.project,
      period: req.query.period || '24h'
    });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/changelog/events - SSE stream for real-time changelog
app.get('/api/changelog/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  changelogClients.push(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    changelogClients = changelogClients.filter(c => c !== res);
  });
});

app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    // Cyan + underline + OSC 8 hyperlink for maximum terminal compatibility
    // OSC 8: \x1b]8;;URL\x1b\\ ... \x1b]8;;\x1b\\
    // Cyan: \x1b[36m, Underline: \x1b[4m, Reset: \x1b[0m
    console.log(`Watchpost running at \x1b]8;;${url}\x1b\\\x1b[36m\x1b[4m${url}\x1b[0m\x1b]8;;\x1b\\`);
    console.log(`Serving static files from: ${__dirname}`);

    // BUG-1113: Clean up stale worktrees on startup (older than 24h)
    console.log('[Startup] Checking for stale worktrees...');
    const cleanupResults = cleanupStaleWorktrees(24);
    if (cleanupResults.cleaned.length > 0) {
        console.log(`[Startup] Cleaned ${cleanupResults.cleaned.length} stale worktrees`);
    }

    // TASK-322: Recover orphaned tasks (in_progress in beads but no running agent)
    try {
        const masterPlanPath = process.env.MASTER_PLAN_PATH || '';
        const orphanProjectRoot = masterPlanPath ? getProjectRoot(masterPlanPath) : path.join(__dirname, '..');
        const result = execSync(`${BD_PATH} list --status in_progress --json`, { cwd: orphanProjectRoot, timeout: 5000 });
        const orphans = JSON.parse(result.toString());
        for (const task of orphans) {
            if (!runningAgents.has(task.id)) {
                console.log(`[Recovery] Reverting orphaned task ${task.id} from in_progress to todo`);
                execSync(`${BD_PATH} update ${task.id} --status todo`, { cwd: orphanProjectRoot, timeout: 5000 });
            }
        }
        if (orphans.length > 0) {
            const reverted = orphans.filter(t => !runningAgents.has(t.id));
            if (reverted.length > 0) {
                console.log(`[Recovery] Reverted ${reverted.length} orphaned task(s) to todo`);
            }
        }
    } catch (e) {
        console.log('[Recovery] Could not check for orphaned tasks:', e.message);
    }

    // BUG-1113: Periodic cleanup every 1 hour (reduced from 4 hours)
    setInterval(() => {
        console.log('[Periodic] Running worktree cleanup...');
        cleanupStaleWorktrees(4); // 4 hour threshold (reduced from 24)
    }, 60 * 60 * 1000); // 1 hour

    // Initialize changelog engine
    try {
        const changelogDbPath = path.join(__dirname, 'data', 'changelog.db');
        changelogEngine.initDb(changelogDbPath);
        console.log('[Changelog] Database initialized');

        // Initial ingestion
        const initialCount = changelogEngine.ingestNewEntries();
        if (initialCount > 0) {
            console.log(`[Changelog] Ingested ${initialCount} entries from JSONL files`);
            // Enrich agent IDs from Claude session data
            try {
                const enriched = changelogEngine.enrichAgentIds();
                if (enriched > 0) console.log(`[Changelog] Enriched ${enriched} entries with agent IDs`);
            } catch (err) {
                console.error('[Changelog] Enrichment error:', err.message);
            }
        }

        // Poll for new entries every 5 seconds
        setInterval(() => {
            try {
                const newEntries = changelogEngine.ingestNewEntries();
                if (newEntries > 0) {
                    // Enrich agent IDs from Claude session data
                    try {
                        const enriched = changelogEngine.enrichAgentIds();
                        if (enriched > 0) console.log(`[Changelog] Enriched ${enriched} entries with agent IDs`);
                    } catch (err) {
                        console.error('[Changelog] Enrichment error:', err.message);
                    }
                    // Broadcast to SSE clients
                    const payload = JSON.stringify({ type: 'new-actions', count: newEntries });
                    changelogClients.forEach(client => {
                        try { client.write(`data: ${payload}\n\n`); } catch {}
                    });
                }
            } catch (err) {
                console.error('[Changelog] Ingestion error:', err.message);
            }
        }, 5000);

        // Weekly cleanup (90 day retention)
        setInterval(() => {
            try {
                const deleted = changelogEngine.cleanup(90);
                const rotated = changelogEngine.rotateJsonlFiles(30);
                if (deleted > 0 || rotated > 0) {
                    console.log(`[Changelog] Cleaned ${deleted} DB entries, rotated ${rotated} JSONL files`);
                }
            } catch {}
        }, 7 * 24 * 60 * 60 * 1000);
    } catch (err) {
        console.error('[Changelog] Failed to initialize:', err.message);
    }

    // Auto-discover projects on startup
    if (localConfig.projectAutoScan !== false) {
        const scanPaths = localConfig.projectScanPaths || [process.env.HOME];
        const scanDepth = localConfig.projectScanDepth || 5;
        try {
            console.log(`[Scanner] Auto-scanning for projects in: ${scanPaths.join(', ')}`);
            const result = projectScanner.syncDiscoveredProjects(scanPaths, projectsJsonPath, { maxDepth: scanDepth });
            console.log(`[Scanner] Found ${result.total} projects (${result.added.length} new)`);
            if (result.added.length > 0) {
                result.added.forEach(p => console.log(`[Scanner]   + ${p.name} (${p.root})`));
            }
        } catch (err) {
            console.error('[Scanner] Auto-scan failed:', err.message);
        }
    }

    // Auto-activate project matching WATCHPOST_CWD (if set from wrapper script)
    if (process.env.WATCHPOST_CWD) {
        const cwd = process.env.WATCHPOST_CWD;
        const data = readProjects();
        // Find the project whose root is a prefix of (or equals) CWD
        const match = data.projects.find(p => cwd.startsWith(p.root));
        if (match && match.masterPlan && match.masterPlan !== process.env.MASTER_PLAN_PATH) {
            process.env.MASTER_PLAN_PATH = match.masterPlan;
            updateEnvFile('MASTER_PLAN_PATH', match.masterPlan);
            console.log(`[Startup] Auto-activated project from CWD: ${match.name} (${match.root})`);
            // Re-init task engine for the correct project
            taskEngine.closeDb();
            initTaskEngine();
        }
    }

    // Periodic re-scan every 5 minutes (if auto-scan enabled)
    if (localConfig.projectAutoScan !== false) {
        setInterval(() => {
            const scanPaths = localConfig.projectScanPaths || [process.env.HOME];
            const scanDepth = localConfig.projectScanDepth || 5;
            try {
                const result = projectScanner.syncDiscoveredProjects(scanPaths, projectsJsonPath, { maxDepth: scanDepth });
                if (result.added.length > 0) {
                    console.log(`[Scanner] Periodic scan: found ${result.added.length} new project(s)`);
                    result.added.forEach(p => console.log(`[Scanner]   + ${p.name} (${p.root})`));
                    // Notify SSE clients about new projects
                    const payload = JSON.stringify({ type: 'projects-updated', added: result.added.map(p => p.name) });
                    clients.forEach(client => client.write(`data: ${payload}\n\n`));
                }
            } catch (err) {
                console.error('[Scanner] Periodic scan error:', err.message);
            }
        }, 5 * 60 * 1000); // 5 minutes
    }

});
