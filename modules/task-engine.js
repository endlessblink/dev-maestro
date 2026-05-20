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
      lane TEXT,
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

  const columns = db.prepare("PRAGMA table_info(tasks)").all().map(column => column.name);
  if (!columns.includes('lane')) {
    db.exec('ALTER TABLE tasks ADD COLUMN lane TEXT');
  }

  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// ── MD Parsing ──────────────────────────────────────────────────────

const TASK_ID_SOURCE = '[A-Z][A-Z0-9]*-\\d+';
const TASK_HEADER_RE = new RegExp(`^###\\s+(~~)?(${TASK_ID_SOURCE})(~~)?(?:\\s*[:\\-–—]\\s*|\\s+)(.+?)(?:\\s*\\(([^)]+)\\))?\\s*$`);
const FIELD_RE = /^\*\*([\w \/]+):?\*\*:?\s*(.*)/;

// Table row: | ID | title | priority | status | deps |
// Handles: bold (**TASK-001**), strikethrough (~~TASK-001~~), combined (~~**TASK-001**~~)
// Cells may be wrapped in ~~ and/or ** for done tasks
const TABLE_ROW_RE = new RegExp('^\\|\\s*(?:~~)?(?:\\*\\*)?(?:`?)?(' + TASK_ID_SOURCE + ')(?:`?)?(?:\\*\\*)?(?:~~)?\\s*\\|');

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
    .filter(s => new RegExp(`^${TASK_ID_SOURCE}$`).test(s));
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
        lane: '',
        deps: [],
      };
      continue;
    }

    // ── Table row parsing ────────────────────────────────────────────
    const tableMatch = line.match(TABLE_ROW_RE);
    if (tableMatch) {
      flush();
      current = null; // table rows are standalone, not nested under headers

      const taskId = tableMatch[1];
      const isStrikethrough = line.includes('~~');

      // Split cells by |, trim each, filter empties
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      // cells[0] = ID (possibly wrapped in ~~ or **)
      // Remaining cells vary by format — detect which format we have

      let title = '';
      let priority = 'P2';
      let lane = '';
      let status = isStrikethrough ? 'done' : 'planned';
      let deps = [];

      // Clean markdown formatting from a cell value
      const clean = (s) => s.replace(/\*\*/g, '').replace(/~~/g, '').replace(/`/g, '').trim();

      if (cells.length >= 6 && /^P[0-4]$/i.test(clean(cells[4]))) {
        // Format A1: ID | Lane | Task | Status | Priority | Deps
        lane = clean(cells[1]);
        title = clean(cells[2]);
        priority = parsePriority(clean(cells[4]));
        const rawStatus = clean(cells[3]);
        if (!isStrikethrough) status = parseStatus(null, rawStatus);
        const depStr = clean(cells[5]);
        if (depStr && depStr !== '-' && depStr !== '—') deps = parseDeps(depStr);
      } else if (cells.length >= 5) {
        // Format A: ID | Title | Priority | Status | Deps
        title = clean(cells[1]);
        priority = parsePriority(clean(cells[2]));
        const rawStatus = clean(cells[3]);
        if (!isStrikethrough) status = parseStatus(null, rawStatus);
        const depStr = clean(cells[4]);
        if (depStr && depStr !== '-') deps = parseDeps(depStr);
      } else if (cells.length >= 3) {
        // Format B: ID | Priority | Title (with possible emoji status)
        const cell1 = clean(cells[1]);
        const cell2 = clean(cells[2]);

        // Detect if cell1 is a priority (P0/P1/P2/P3) or a title
        if (/^P[0-4]$/i.test(cell1)) {
          priority = parsePriority(cell1);
          title = cell2;
        } else {
          // cell1 is the title, cell2 might be priority or deps
          title = cell1;
          if (/^P[0-4]$/i.test(cell2)) {
            priority = parsePriority(cell2);
          }
        }

        // Check for emoji status in the title or raw cells
        const rawLine = cells.join(' ');
        if (!isStrikethrough) {
          if (/DONE|done/.test(rawLine)) status = 'done';
          else if (/IN.?PROGRESS|WIP|wip/i.test(rawLine)) status = 'in_progress';
          else if (/REVIEW|review/i.test(rawLine)) status = 'review';
          else if (/PAUSED|FROZEN|paused|frozen/i.test(rawLine)) status = 'paused';
          else if (/TODO|PLANNED|todo|planned/i.test(rawLine)) status = 'planned';
        }
      } else if (cells.length >= 2) {
        // Format C: ID | Title (no status/priority)
        title = clean(cells[1]);
      }

      // Strip leading emoji status markers from title
      title = title.replace(/^[\u2705\u{1F9CA}\u{1F440}\u{1F6A7}\u26A0\uFE0F\u{1F525}\u2B50]\s*/u, '').trim();

      // Skip template/example rows
      if (title && !taskId.includes('XXX')) {
        tasks.push({ id: taskId, title, status, priority, lane, deps });
      }
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
  const parsedTasks = parseMarkdown(content);
  const taskMap = new Map();
  for (const task of parsedTasks) {
    const existing = taskMap.get(task.id);
    taskMap.set(task.id, existing ? {
      ...existing,
      ...task,
      deps: task.deps.length > 0 ? task.deps : existing.deps,
      lane: task.lane || existing.lane,
    } : task);
  }
  const tasks = Array.from(taskMap.values());
  const now = new Date().toISOString();

  const upsertTask = db.prepare(`
    INSERT INTO tasks (id, title, status, priority, lane, created_at, updated_at)
    VALUES (@id, @title, @status, @priority, @lane, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      title = @title,
      status = @status,
      priority = @priority,
      lane = @lane,
      updated_at = @now,
      closed_at = CASE WHEN @status = 'done' THEN COALESCE(tasks.closed_at, @now) ELSE NULL END
  `);

  const deleteDeps = db.prepare('DELETE FROM deps WHERE task_id = ?');
  const insertDep = db.prepare('INSERT OR IGNORE INTO deps (task_id, depends_on) VALUES (?, ?)');

  const syncAll = db.transaction(() => {
    for (const task of tasks) {
      upsertTask.run({ id: task.id, title: task.title, status: task.status, priority: task.priority, lane: task.lane || '', now });
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
  const nodes = db.prepare('SELECT id, title, status, priority, lane FROM tasks').all();
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
