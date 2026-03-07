'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');

let db = null;

// ── Database lifecycle ──────────────────────────────────────────────

function initDb(dbPath) {
  const dir = require('path').dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'planned',
      priority TEXT DEFAULT 'P2',
      created_at TEXT,
      updated_at TEXT,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deps (
      task_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      content TEXT,
      created_at TEXT
    );
  `);

  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// ── MD Parsing ──────────────────────────────────────────────────────

const TASK_HEADER_RE = /^###\s+(~~)?((?:TASK|BUG|FEATURE|ROAD|IDEA|ISSUE)-\d+)(~~)?:\s*(.+?)(?:\s*\(([^)]+)\))?\s*$/;
const FIELD_RE = /^\*\*([\w \/]+)\*\*[^:]*:\s*(.*)/;

const STATUS_EMOJI_MAP = {
  '🔄 IN PROGRESS': 'in_progress',
  '🔄 in progress': 'in_progress',
  '⏸️ PAUSED': 'paused',
  '⏸ PAUSED': 'paused',
  '👀 REVIEW': 'review',
  '✅ DONE': 'done',
  '✅ done': 'done',
};

const STATUS_TEXT_MAP = {
  'in progress': 'in_progress',
  'in_progress': 'in_progress',
  'planned': 'planned',
  'todo': 'planned',
  'paused': 'paused',
  'review': 'review',
  'done': 'done',
  'complete': 'done',
  'completed': 'done',
};

const PRIORITY_TEXT_MAP = {
  'p0': 'P0', 'p1': 'P1', 'p2': 'P2', 'p3': 'P3',
  'high': 'P0', 'medium': 'P1', 'low': 'P2',
  'critical': 'P0',
};

function parseStatus(headerEmoji, statusFieldValue) {
  // Status field takes priority if present
  if (statusFieldValue) {
    const lower = statusFieldValue.trim().toLowerCase();
    if (STATUS_TEXT_MAP[lower]) return STATUS_TEXT_MAP[lower];
  }
  // Try header emoji
  if (headerEmoji) {
    const trimmed = headerEmoji.trim();
    if (STATUS_EMOJI_MAP[trimmed]) return STATUS_EMOJI_MAP[trimmed];
    // Try case-insensitive text match
    const lower = trimmed.toLowerCase();
    if (STATUS_TEXT_MAP[lower]) return STATUS_TEXT_MAP[lower];
  }
  return 'planned';
}

function parsePriority(value) {
  if (!value) return 'P2';
  const lower = value.trim().toLowerCase();
  return PRIORITY_TEXT_MAP[lower] || 'P2';
}

function parseDeps(value) {
  if (!value) return [];
  return value.split(',')
    .map(s => s.trim())
    .filter(s => /^(TASK|BUG|FEATURE|ROAD|IDEA|ISSUE)-\d+$/.test(s));
}

function parseMarkdown(mdContent) {
  const lines = mdContent.split('\n');
  const tasks = [];
  let current = null;

  const flush = () => {
    if (current) tasks.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const headerMatch = line.match(TASK_HEADER_RE);
    if (headerMatch) {
      flush();
      const isStrikethrough = !!headerMatch[1];
      const id = headerMatch[2];
      const title = headerMatch[4].trim();
      const emojiStatus = headerMatch[5] || null;

      current = {
        id,
        title,
        status: isStrikethrough ? 'done' : parseStatus(emojiStatus, null),
        priority: 'P2',
        deps: [],
      };
      continue;
    }

    // A new section (h1, h2, h3) that isn't a task header ends current task
    if (current && /^#{1,3}\s/.test(line)) {
      flush();
      current = null;
      continue;
    }

    if (!current) continue;

    const fieldMatch = line.match(FIELD_RE);
    if (fieldMatch) {
      const name = fieldMatch[1].trim();
      const value = fieldMatch[2].trim();

      if (name === 'Status') {
        const parsed = parseStatus(null, value);
        if (current.status !== 'done') current.status = parsed; // strikethrough wins
      } else if (name === 'Priority') {
        current.priority = parsePriority(value);
      } else if (name === 'Depends') {
        current.deps = parseDeps(value);
      }
    }
  }

  flush();
  return tasks;
}

// ── MASTER_PLAN.md sync ─────────────────────────────────────────────

function syncFromMarkdown(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  const tasks = parseMarkdown(content);
  const now = new Date().toISOString();

  const upsertTask = db.prepare(`
    INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
    VALUES (@id, @title, @status, @priority, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      title = @title,
      status = @status,
      priority = @priority,
      updated_at = @now,
      closed_at = CASE WHEN @status = 'done' THEN COALESCE(tasks.closed_at, @now) ELSE NULL END
  `);

  const deleteDeps = db.prepare('DELETE FROM deps WHERE task_id = ?');
  const insertDep = db.prepare('INSERT OR IGNORE INTO deps (task_id, depends_on) VALUES (?, ?)');

  const syncAll = db.transaction(() => {
    for (const task of tasks) {
      upsertTask.run({ id: task.id, title: task.title, status: task.status, priority: task.priority, now });
      deleteDeps.run(task.id);
      for (const dep of task.deps) {
        insertDep.run(task.id, dep);
      }
    }
  });

  syncAll();
  return tasks.length;
}

function writeBackStatus(mdPath, taskId, newStatus) {
  const content = fs.readFileSync(mdPath, 'utf8');
  const lines = content.split('\n');
  const isDone = newStatus === 'done';

  const statusEmojiMap = {
    'planned': '',
    'in_progress': '(🔄 IN PROGRESS)',
    'paused': '(⏸️ PAUSED)',
    'review': '(👀 REVIEW)',
    'done': '(✅ DONE)',
  };

  const humanStatusMap = {
    'planned': 'Todo',
    'in_progress': 'In Progress',
    'paused': 'Paused',
    'review': 'Review',
    'done': 'Done',
  };

  const headerRegex = new RegExp(`^###\\s+(?:~~)?${taskId}(?:~~)?:\\s*(.+?)(?:\\s*\\([^)]+\\))?\\s*$`);
  let inTask = false;
  let foundStatusLine = false;
  let headerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRegex);
    if (match) {
      const title = match[1].trim();
      const idStr = isDone ? `~~${taskId}~~` : taskId;
      const suffix = statusEmojiMap[newStatus] || '';
      lines[i] = `### ${idStr}: ${title}${suffix ? ' ' + suffix : ''}`;
      inTask = true;
      headerIdx = i;
      continue;
    }

    if (inTask && /^#{1,3}\s/.test(lines[i])) {
      inTask = false;
    }

    if (inTask && lines[i].trim().startsWith('**Status**:')) {
      lines[i] = `**Status**: ${humanStatusMap[newStatus] || newStatus}`;
      foundStatusLine = true;
    }
  }

  if (headerIdx >= 0 && !foundStatusLine) {
    // Insert status line after header (skip blank lines)
    let insertIdx = headerIdx + 1;
    while (insertIdx < lines.length && lines[insertIdx].trim() === '') insertIdx++;
    lines.splice(insertIdx, 0, `**Status**: ${humanStatusMap[newStatus] || newStatus}`);
  }

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
}

// ── Query functions ─────────────────────────────────────────────────

function getTasks(filters) {
  let sql = 'SELECT * FROM tasks';
  const conditions = [];
  const params = {};

  if (filters) {
    if (filters.status) {
      conditions.push('status = @status');
      params.status = filters.status;
    }
    if (filters.priority) {
      conditions.push('priority = @priority');
      params.priority = filters.priority;
    }
  }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY id';

  return db.prepare(sql).all(params);
}

function getTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;
  task.deps = db.prepare('SELECT depends_on FROM deps WHERE task_id = ?').all(id).map(r => r.depends_on);
  task.comments = db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at').all(id);
  return task;
}

function getReady() {
  // Tasks not done where ALL deps are done (or no deps)
  return db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.status != 'done'
      AND NOT EXISTS (
        SELECT 1 FROM deps d
        JOIN tasks dt ON dt.id = d.depends_on
        WHERE d.task_id = t.id AND dt.status != 'done'
      )
    ORDER BY
      CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      t.id
  `).all();
}

function getBlocked() {
  return db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.status != 'done'
      AND EXISTS (
        SELECT 1 FROM deps d
        JOIN tasks dt ON dt.id = d.depends_on
        WHERE d.task_id = t.id AND dt.status != 'done'
      )
    ORDER BY t.id
  `).all();
}

function getGraph() {
  const nodes = db.prepare('SELECT id, title, status, priority FROM tasks').all();
  const links = db.prepare('SELECT task_id AS target, depends_on AS source FROM deps').all();
  return { nodes, links };
}

function getStats() {
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status').all();
  const byPriority = db.prepare('SELECT priority, COUNT(*) as count FROM tasks GROUP BY priority').all();
  const total = db.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
  return { total, byStatus, byPriority };
}

// ── Mutations ───────────────────────────────────────────────────────

function updateStatus(id, status) {
  const now = new Date().toISOString();
  const closedAt = status === 'done' ? now : null;
  return db.prepare(`
    UPDATE tasks SET status = ?, updated_at = ?, closed_at = COALESCE(?, closed_at)
    WHERE id = ?
  `).run(status, now, closedAt, id);
}

function addDep(taskId, dependsOn) {
  if (hasCycle(taskId, dependsOn)) {
    throw new Error(`Adding dependency ${taskId} -> ${dependsOn} would create a cycle`);
  }
  return db.prepare('INSERT OR IGNORE INTO deps (task_id, depends_on) VALUES (?, ?)').run(taskId, dependsOn);
}

function removeDep(taskId, dependsOn) {
  return db.prepare('DELETE FROM deps WHERE task_id = ? AND depends_on = ?').run(taskId, dependsOn);
}

function addComment(taskId, content) {
  const now = new Date().toISOString();
  return db.prepare('INSERT INTO comments (task_id, content, created_at) VALUES (?, ?, ?)').run(taskId, content, now);
}

// ── Cycle detection ─────────────────────────────────────────────────

function hasCycle(taskId, newDep) {
  // If adding taskId -> newDep, check if newDep can reach taskId via existing deps
  // (that would mean taskId transitively depends on itself)
  const allDeps = db.prepare('SELECT task_id, depends_on FROM deps').all();
  const adj = new Map();
  for (const { task_id, depends_on } of allDeps) {
    if (!adj.has(task_id)) adj.set(task_id, []);
    adj.get(task_id).push(depends_on);
  }
  // Temporarily add the new edge
  if (!adj.has(taskId)) adj.set(taskId, []);
  adj.get(taskId).push(newDep);

  // DFS from taskId following dependency edges; if we reach taskId again, cycle exists
  const visited = new Set();
  const stack = [taskId];
  visited.add(taskId);

  while (stack.length > 0) {
    const node = stack.pop();
    const neighbors = adj.get(node) || [];
    for (const next of neighbors) {
      if (next === taskId && node !== taskId) return true; // found cycle back to taskId
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }

  return false;
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  initDb,
  closeDb,
  syncFromMarkdown,
  writeBackStatus,
  getTasks,
  getTask,
  getReady,
  getBlocked,
  getGraph,
  getStats,
  updateStatus,
  addDep,
  removeDep,
  addComment,
  hasCycle,
};
