import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseMasterPlanTasks, getMasterPlanPath } from './masterplan-parser.js';

// ── Server URL resolution ───────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(process.env.HOME, '.dev-maestro', '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  return env;
}

function loadLocalConfig() {
  const cfgPath = path.join(process.env.HOME, '.dev-maestro', 'local', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch { return {}; }
}

const dotEnv = loadEnv();
const localConfig = loadLocalConfig();
const SERVER_PORT = process.env.PORT || localConfig.port || dotEnv.PORT || 6010;
const SERVER_URL = process.env.MAESTRO_SERVER_URL || `http://localhost:${SERVER_PORT}`;

// ── Status & priority mapping (task-engine <-> TUI) ─────────────────
// Task engine uses: planned, in_progress, review, paused, done
// TUI/bd uses:      open, in_progress, inreview, closed

function engineStatusToTui(status) {
  const map = {
    planned: 'open',
    in_progress: 'in_progress',
    review: 'inreview',
    paused: 'open',
    done: 'closed',
  };
  return map[status] || 'open';
}

function tuiStatusToEngine(status) {
  const map = {
    open: 'planned',
    in_progress: 'in_progress',
    inreview: 'review',
    closed: 'done',
  };
  return map[status] || 'planned';
}

function enginePriorityToNumeric(priority) {
  const map = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return map[priority] ?? 2;
}

// Transform a task-engine row into the shape TUI expects (bd-compatible)
function transformTask(task) {
  return {
    id: task.id,
    title: task.title,
    status: engineStatusToTui(task.status),
    priority: enginePriorityToNumeric(task.priority),
    issue_type: task.id?.match(/^([A-Z]+)-/)?.[1]?.toLowerCase() || 'task',
    created_at: task.created_at || '',
    updated_at: task.updated_at || '',
    closed_at: task.closed_at || '',
    labels: task.status === 'review' ? ['review'] : [],
    external_ref: task.id,
    // Pass through any extra fields
    ...(task.description ? { description: task.description } : {}),
    ...(task.deps ? { deps: task.deps } : {}),
  };
}

// ── BD binary fallback ──────────────────────────────────────────────

export const BD_PATH = process.env.BD_PATH || (() => {
  const candidates = [
    `${process.env.HOME}/app-data/go/bin/bd`,
    `${process.env.HOME}/go/bin/bd`,
    '/usr/local/bin/bd',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'bd';
})();

// CWD resolution for bd binary fallback
const PROJECT_ROOT = (() => {
  const cwd = process.env.MAESTRO_CWD;
  if (cwd) {
    if (fs.existsSync(path.join(cwd, '.beads'))) return cwd;
    const candidates = [
      path.join(cwd, 'docs', 'MASTER_PLAN.md'),
      path.join(cwd, 'MASTER_PLAN.md'),
      path.join(cwd, 'planning', 'MASTER_PLAN.md'),
      path.join(cwd, 'doc', 'MASTER_PLAN.md'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const planDir = path.dirname(p);
        const dirName = path.basename(planDir);
        if (['docs', 'doc', 'planning', '.github'].includes(dirName)) {
          return path.dirname(planDir);
        }
        return planDir;
      }
    }
  }
  const mp = process.env.MASTER_PLAN_PATH || dotEnv.MASTER_PLAN_PATH;
  if (mp) {
    const planDir = path.dirname(mp);
    const dirName = path.basename(planDir);
    if (['docs', 'doc', 'planning', '.github'].includes(dirName)) {
      return path.dirname(planDir);
    }
    return planDir;
  }
  return path.resolve(process.env.HOME, '.dev-maestro', '..');
})();

const BEADS_DIR = (() => {
  const beadsPath = path.join(PROJECT_ROOT, '.beads');
  if (fs.existsSync(beadsPath)) return beadsPath;
  return null;
})();

const EXEC_OPTS = {
  encoding: 'utf8',
  timeout: 15000,
  cwd: PROJECT_ROOT,
  env: { ...process.env, ...(BEADS_DIR ? { BEADS_DIR } : {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
};

function bdFallback(args) {
  try {
    const result = execSync(`${BD_PATH} ${args} --json`, EXEC_OPTS);
    return JSON.parse(result);
  } catch { return null; }
}

function bdExecFallback(args) {
  try {
    const output = execSync(`${BD_PATH} ${args}`, EXEC_OPTS);
    return { success: true, output: output.trim() };
  } catch (err) {
    return { success: false, output: err.stderr?.toString() || err.message };
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────

async function fetchJson(urlPath, options = {}) {
  const url = `${SERVER_URL}${urlPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { signal: controller.signal, ...options });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Track server availability to avoid repeated timeouts
let _serverDown = false;
let _lastCheck = 0;
const SERVER_RETRY_MS = 15000;

async function isServerUp() {
  const now = Date.now();
  if (_serverDown && now - _lastCheck < SERVER_RETRY_MS) return false;
  try {
    await fetchJson('/api/status');
    _serverDown = false;
    return true;
  } catch {
    _serverDown = true;
    _lastCheck = now;
    return false;
  }
}

// ── Public API (same shape as before, but async with sync fallback) ─

/**
 * Run a bd query, return parsed data or null.
 * Tries REST API first, falls back to bd binary.
 */
export function bd(args) {
  // Synchronous — try bd binary since we can't do async in sync context
  // For the REST path, use bdAsync() instead
  return bdFallback(args);
}

// ── MASTER_PLAN.md fallback (cached per process) ────────────────────
let _masterPlanTasks = null;

function getMasterPlanFallback(args) {
  if (!_masterPlanTasks) {
    const mpPath = getMasterPlanPath();
    _masterPlanTasks = mpPath ? parseMasterPlanTasks(mpPath) : [];
  }
  if (!_masterPlanTasks.length) return null;

  const parts = args.trim().split(/\s+/);
  const cmd = parts[0];

  if (cmd === 'list') {
    const statusMatch = args.match(/--status=(\S+)/);
    if (statusMatch) {
      const filter = statusMatch[1];
      return _masterPlanTasks.filter(t => t.status === filter);
    }
    // Default: return non-closed
    return _masterPlanTasks.filter(t => t.status !== 'closed');
  }
  if (cmd === 'ready') {
    // "Ready" = planned tasks (open status, not review)
    return _masterPlanTasks.filter(t => t.status === 'open' && !t.labels?.includes('review'));
  }
  if (cmd === 'blocked') {
    return []; // No dependency info in MASTER_PLAN.md
  }
  if (cmd === 'stats') {
    const total = _masterPlanTasks.length;
    const open = _masterPlanTasks.filter(t => t.status === 'open').length;
    const wip = _masterPlanTasks.filter(t => t.status === 'in_progress').length;
    const review = _masterPlanTasks.filter(t => t.status === 'inreview').length;
    const done = _masterPlanTasks.filter(t => t.status === 'closed').length;
    return { summary: { total, open, in_progress: wip, review, done } };
  }
  return null;
}

/**
 * Async version of bd() — prefers REST API, falls back to bd binary,
 * then falls back to parsing MASTER_PLAN.md directly.
 */
export async function bdAsync(args) {
  try {
    if (await isServerUp()) {
      return await bdRoute(args);
    }
  } catch { /* fall through */ }

  // Try bd binary
  const bdResult = bdFallback(args);
  if (bdResult && (Array.isArray(bdResult) ? bdResult.length > 0 : bdResult)) {
    return bdResult;
  }

  // Final fallback: parse MASTER_PLAN.md directly
  return getMasterPlanFallback(args);
}

async function bdRoute(args) {
  // Parse the bd command args and route to the right endpoint
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0];

  if (cmd === 'list') {
    const statusMatch = args.match(/--status=(\S+)/);
    const statusFilter = statusMatch ? statusMatch[1] : null;
    let urlPath = '/api/tasks/list';
    if (statusFilter) urlPath += `?status=${statusFilter}`;
    const data = await fetchJson(urlPath);
    const tasks = data.tasks || data.issues || data || [];
    return Array.isArray(tasks) ? tasks.map(transformTask) : [];
  }

  if (cmd === 'ready') {
    const data = await fetchJson('/api/tasks/ready');
    const tasks = data.tasks || data.issues || data || [];
    return Array.isArray(tasks) ? tasks.map(transformTask) : [];
  }

  if (cmd === 'blocked') {
    const data = await fetchJson('/api/tasks/blocked');
    const tasks = data.tasks || data.issues || data || [];
    return Array.isArray(tasks) ? tasks.map(transformTask) : [];
  }

  if (cmd === 'stats') {
    const data = await fetchJson('/api/tasks/stats');
    // Wrap in summary shape that use-board-data expects
    return { summary: data };
  }

  // Unknown command — fall back to bd binary
  return bdFallback(args);
}

/**
 * Run a bd mutation command. Returns { success, output }.
 * Tries REST API first, falls back to bd binary.
 */
export function bdExec(args) {
  // Synchronous fallback
  return bdExecFallback(args);
}

/**
 * Async version of bdExec() — prefers REST API, falls back to bd binary.
 */
export async function bdExecAsync(args) {
  try {
    if (await isServerUp()) {
      return await bdExecRoute(args);
    }
  } catch { /* fall through */ }
  return bdExecFallback(args);
}

async function bdExecRoute(args) {
  const parts = args.trim().split(/\s+/);
  const cmd = parts[0];

  if (cmd === 'close') {
    const id = parts[1];
    if (!id) return { success: false, output: 'Missing task ID' };
    await fetchJson(`/api/tasks/${id}/close`, { method: 'POST' });
    return { success: true, output: `Closed ${id}` };
  }

  if (cmd === 'update') {
    const id = parts[1];
    if (!id) return { success: false, output: 'Missing task ID' };
    const statusMatch = args.match(/--status\s+(\S+)/);
    const assigneeMatch = args.match(/--assignee\s+(\S+)/);

    if (statusMatch) {
      const engineStatus = tuiStatusToEngine(statusMatch[1]);
      await fetchJson(`/api/tasks/${id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: engineStatus }),
      });
      return { success: true, output: `Updated ${id} status to ${statusMatch[1]}` };
    }

    if (assigneeMatch) {
      // Assignee updates — try claim endpoint or fall back
      try {
        await fetchJson(`/api/tasks/${id}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignee: assigneeMatch[1] }),
        });
        return { success: true, output: `Assigned ${id} to ${assigneeMatch[1]}` };
      } catch {
        return bdExecFallback(args);
      }
    }

    return bdExecFallback(args);
  }

  if (cmd === 'create') {
    // Create isn't in the new API yet — fall back to bd binary
    return bdExecFallback(args);
  }

  // Unknown command — fall back
  return bdExecFallback(args);
}
