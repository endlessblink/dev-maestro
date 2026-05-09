'use strict';

/**
 * Cross-platform path resolver for Watchpost.
 *
 * Resolution order for each path:
 *   1. Explicit env var (e.g. WATCHPOST_CLAUDE_PROJECTS_DIR)
 *   2. Platform-specific default (Linux/macOS via $HOME, Windows via %USERPROFILE% / %APPDATA%)
 *
 * Path mappings:
 *   Optional WATCHPOST_PATH_MAPPINGS env var or projects.json `pathMappings` entry
 *   lets a single project registry resolve on both Linux and Windows when the
 *   underlying storage is shared (dual-boot with NTFS data drive, WSL on /mnt/c, etc.).
 *
 *   Format:
 *     [
 *       { "linux": "/media/endlessblink/data", "windows": "D:\\" },
 *       { "linux": "/home/endlessblink",       "windows": "C:\\Users\\endlessblink" }
 *     ]
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

function envPath(name) {
    const value = process.env[name];
    return value && value.trim() ? value.trim() : null;
}

function home() {
    return os.homedir() || (IS_WIN ? 'C:\\' : '/');
}

function watchpostDir() {
    return envPath('WATCHPOST_DIR') || path.resolve(__dirname, '..');
}

function dataDir() {
    return envPath('WATCHPOST_DATA_DIR') || path.join(watchpostDir(), 'data');
}

function projectsFile() {
    return envPath('WATCHPOST_PROJECTS_FILE') || path.join(watchpostDir(), 'projects.json');
}

/**
 * Idempotent: ensure projects.json exists with the canonical empty shape.
 * Call once at startup so downstream readers never face an ENOENT race.
 * Returns { path, created } so callers can log on first creation.
 */
function ensureProjectsFile() {
    const file = projectsFile();
    if (fs.existsSync(file)) return { path: file, created: false };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projects: [], pathMappings: [] }, null, 2));
    return { path: file, created: true };
}

function settingsFile() {
    return envPath('WATCHPOST_SETTINGS_FILE') || path.join(watchpostDir(), 'settings.json');
}

/**
 * Default location for Claude Code session JSONL files.
 * Linux/macOS: ~/.claude/projects
 * Windows:     %USERPROFILE%\.claude\projects
 */
function claudeProjectsDir() {
    return envPath('WATCHPOST_CLAUDE_PROJECTS_DIR') || path.join(home(), '.claude', 'projects');
}

/**
 * Additional Claude project dirs to scan (comma-separated env var).
 * Useful when bridging WSL and Windows on one machine.
 */
function claudeProjectsDirs() {
    const primary = claudeProjectsDir();
    const extras = (envPath('WATCHPOST_CLAUDE_PROJECTS_DIRS') || '')
        .split(/[;,]/)
        .map(s => s.trim())
        .filter(Boolean);
    const all = [primary, ...extras];
    return Array.from(new Set(all)).filter(p => {
        try { return fs.existsSync(p); } catch { return false; }
    });
}

/**
 * Default location for OpenCode storage.
 * Linux:   ~/.local/share/opencode/storage
 * macOS:   ~/Library/Application Support/opencode/storage
 * Windows: %APPDATA%\opencode\storage
 */
function opencodeStorageDir() {
    if (envPath('WATCHPOST_OPENCODE_STORAGE_DIR')) return envPath('WATCHPOST_OPENCODE_STORAGE_DIR');
    if (IS_WIN) {
        const appData = envPath('APPDATA') || path.join(home(), 'AppData', 'Roaming');
        return path.join(appData, 'opencode', 'storage');
    }
    if (process.platform === 'darwin') {
        return path.join(home(), 'Library', 'Application Support', 'opencode', 'storage');
    }
    return path.join(home(), '.local', 'share', 'opencode', 'storage');
}

function opencodeStorageDirs() {
    const primary = opencodeStorageDir();
    const extras = (envPath('WATCHPOST_OPENCODE_STORAGE_DIRS') || '')
        .split(/[;,]/)
        .map(s => s.trim())
        .filter(Boolean);
    const all = [primary, ...extras];
    return Array.from(new Set(all)).filter(p => {
        try { return fs.existsSync(p); } catch { return false; }
    });
}

function defaultSshKey() {
    return path.join(home(), '.ssh', 'id_ed25519');
}

// ─── Path mappings (cross-OS shared storage) ─────────────────────────────────

let cachedMappings = null;

function loadPathMappings() {
    if (cachedMappings) return cachedMappings;
    let mappings = [];

    const fromEnv = envPath('WATCHPOST_PATH_MAPPINGS');
    if (fromEnv) {
        try {
            const parsed = JSON.parse(fromEnv);
            if (Array.isArray(parsed)) mappings = parsed;
        } catch {
            // Ignore malformed env mapping.
        }
    }

    if (mappings.length === 0) {
        try {
            const data = JSON.parse(fs.readFileSync(projectsFile(), 'utf8'));
            if (Array.isArray(data?.pathMappings)) mappings = data.pathMappings;
        } catch {
            // No projects.json or no mappings — fine, just no remapping.
        }
    }

    cachedMappings = mappings
        .map(m => ({
            linux: typeof m?.linux === 'string' ? m.linux : null,
            windows: typeof m?.windows === 'string' ? m.windows : null
        }))
        .filter(m => m.linux && m.windows);

    return cachedMappings;
}

function clearPathMappingCache() {
    cachedMappings = null;
}

function caseFold(s, isWindowsPath) {
    return isWindowsPath ? s.toLowerCase() : s;
}

/**
 * Translate a stored project path (which may be from a different OS) into
 * a path that resolves on the current OS. If no mapping applies, return as-is.
 */
function mapPathToCurrentOS(input) {
    if (!input || typeof input !== 'string') return input;
    const mappings = loadPathMappings();
    if (mappings.length === 0) return input;

    const fromKey = IS_WIN ? 'linux' : 'windows';
    const toKey = IS_WIN ? 'windows' : 'linux';
    const fromIsWindows = fromKey === 'windows';
    const toIsWindows = toKey === 'windows';
    const fromSep = fromIsWindows ? '\\' : '/';

    for (const m of mappings) {
        const from = m[fromKey].replace(/[\\/]+$/, ''); // strip trailing separators
        const to = m[toKey];
        if (!from || !to) continue;

        const inputCmp = caseFold(input, fromIsWindows);
        const fromCmp = caseFold(from, fromIsWindows);

        if (inputCmp === fromCmp || inputCmp.startsWith(fromCmp + fromSep)) {
            const remainder = input.slice(from.length).replace(/^[\\/]+/, '');
            if (!remainder) return to;
            // Build the destination path using the destination OS's separator,
            // since path.join on the current OS uses the current OS's separator
            // (wrong when current=Linux but destination=Windows or vice versa).
            const toBase = to.replace(/[\\/]+$/, '');
            const sep = toIsWindows ? '\\' : '/';
            const remainderNorm = toIsWindows
                ? remainder.replace(/\//g, '\\')
                : remainder.replace(/\\/g, '/');
            return toBase + sep + remainderNorm;
        }
    }

    return input;
}

module.exports = {
    IS_WIN,
    home,
    watchpostDir,
    dataDir,
    projectsFile,
    ensureProjectsFile,
    settingsFile,
    claudeProjectsDir,
    claudeProjectsDirs,
    opencodeStorageDir,
    opencodeStorageDirs,
    defaultSshKey,
    loadPathMappings,
    clearPathMappingCache,
    mapPathToCurrentOS
};
