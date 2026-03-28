'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let db = null;
const CHANGELOG_DIR = path.join(process.env.HOME || '/home/endlessblink', '.dev-maestro/data/changelog');
const CURSOR_FILE = path.join(CHANGELOG_DIR, '_cursor.json');

// ── Database lifecycle ──────────────────────────────────────────────

function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      tool_use_id TEXT UNIQUE,
      agent_id    TEXT,
      tool        TEXT,
      event       TEXT,
      project     TEXT,
      cwd         TEXT,
      file_path   TEXT,
      command     TEXT,
      input_summary TEXT,
      git_branch  TEXT,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id   TEXT PRIMARY KEY,
      project      TEXT,
      started_at   TEXT,
      ended_at     TEXT,
      action_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_actions_project_ts  ON actions (project, ts);
    CREATE INDEX IF NOT EXISTS idx_actions_session_id  ON actions (session_id);
    CREATE INDEX IF NOT EXISTS idx_actions_file_path   ON actions (file_path);
    CREATE INDEX IF NOT EXISTS idx_actions_tool        ON actions (tool);
  `);

  return db;
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

// ── Cursor Management ───────────────────────────────────────────────

function readCursors() {
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'));
  } catch { return {}; }
}

function writeCursors(cursors) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursors, null, 2));
}

// ── File Discovery ───────────────────────────────────────────────────

function discoverJsonlFiles() {
  const files = [];
  if (!fs.existsSync(CHANGELOG_DIR)) return files;

  const entries = fs.readdirSync(CHANGELOG_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('_')) {
      // Legacy flat file
      files.push({ relPath: entry.name, fullPath: path.join(CHANGELOG_DIR, entry.name) });
    } else if (entry.isDirectory() && !entry.name.startsWith('_')) {
      // Project subdirectory — scan for .jsonl files
      const subDir = path.join(CHANGELOG_DIR, entry.name);
      try {
        const subFiles = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
        for (const sf of subFiles) {
          files.push({
            relPath: path.join(entry.name, sf),
            fullPath: path.join(subDir, sf)
          });
        }
      } catch { /* skip unreadable dirs */ }
    }
  }
  return files;
}

// ── Ingestion ───────────────────────────────────────────────────────

function ingestNewEntries() {
  if (!fs.existsSync(CHANGELOG_DIR)) return 0;

  const cursors = readCursors();
  const files = discoverJsonlFiles();

  const insertAction = db.prepare(`
    INSERT OR IGNORE INTO actions
      (ts, session_id, tool_use_id, agent_id, tool, event, project, cwd, file_path, command, input_summary, git_branch, ingested_at)
    VALUES
      (@ts, @session_id, @tool_use_id, @agent_id, @tool, @event, @project, @cwd, @file_path, @command, @input_summary, @git_branch, @ingested_at)
  `);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, project, started_at, ended_at, action_count)
    VALUES (@session_id, @project, @ts, @ts, 1)
    ON CONFLICT(session_id) DO UPDATE SET
      ended_at     = MAX(sessions.ended_at, @ts),
      started_at   = MIN(sessions.started_at, @ts),
      action_count = sessions.action_count + 1,
      project      = COALESCE(sessions.project, @project)
  `);

  const insertMany = db.transaction((entries) => {
    for (const e of entries) {
      const changes = insertAction.run(e);
      if (changes.changes > 0) {
        upsertSession.run({ session_id: e.session_id, project: e.project, ts: e.ts });
      }
    }
  });

  let totalNew = 0;
  const newCursors = { ...cursors };

  for (const file of files) {
    const filePath = file.fullPath;
    const cursorKey = file.relPath;
    const offset = cursors[cursorKey] || 0;

    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (stat.size <= offset) continue;

    // Read only new bytes
    const fd = fs.openSync(filePath, 'r');
    const newBytes = stat.size - offset;
    const buf = Buffer.alloc(newBytes);
    const bytesRead = fs.readSync(fd, buf, 0, newBytes, offset);
    fs.closeSync(fd);

    const chunk = buf.slice(0, bytesRead).toString('utf8');
    const lines = chunk.split('\n');
    const now = new Date().toISOString();
    const entries = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed);
        entries.push({
          ts:            rec.ts || now,
          session_id:    rec.sid || '',
          tool_use_id:   rec.tid || null,
          agent_id:      rec.agent || null,
          tool:          rec.tool || null,
          event:         rec.event || null,
          project:       rec.project || null,
          cwd:           rec.cwd || null,
          file_path:     rec.file || null,
          command:       rec.cmd || null,
          input_summary: rec.summary || null,
          git_branch:    rec.branch || null,
          ingested_at:   now
        });
      } catch { /* skip malformed lines */ }
    }

    if (entries.length > 0) {
      insertMany(entries);
      totalNew += entries.length;
    }

    newCursors[cursorKey] = stat.size;
  }

  writeCursors(newCursors);
  return totalNew;
}

// ── Query Functions ─────────────────────────────────────────────────

function queryActions({ project, session, tool, file, since, until, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = {};

  if (project) {
    conditions.push('project = @project');
    params.project = project;
  }
  if (session) {
    if (session.length < 36) {
      conditions.push('session_id LIKE @session');
      params.session = session + '%';
    } else {
      conditions.push('session_id = @session');
      params.session = session;
    }
  }
  if (tool) {
    const tools = tool.split(',').map(t => t.trim()).filter(Boolean);
    if (tools.length === 1) {
      conditions.push('tool = @tool');
      params.tool = tools[0];
    } else {
      const placeholders = tools.map((t, i) => {
        params[`tool${i}`] = t;
        return `@tool${i}`;
      }).join(', ');
      conditions.push(`tool IN (${placeholders})`);
    }
  }
  if (file) {
    conditions.push('file_path LIKE @file');
    params.file = `%${file}%`;
  }
  if (since) {
    conditions.push('ts >= @since');
    params.since = since;
  }
  if (until) {
    conditions.push('ts <= @until');
    params.until = until;
  }

  params.limit = limit;
  params.offset = offset;

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM actions ${where} ORDER BY ts DESC LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all(params);
}

function querySessions({ project, limit = 20 } = {}) {
  const params = { limit };
  let where = '';
  if (project) {
    where = 'WHERE s.project = @project';
    params.project = project;
  }

  const sessions = db.prepare(`
    SELECT s.*,
           GROUP_CONCAT(DISTINCT a.agent_id) AS agents
    FROM sessions s
    LEFT JOIN actions a ON a.session_id = s.session_id
    ${where}
    GROUP BY s.session_id
    ORDER BY s.started_at DESC
    LIMIT @limit
  `).all(params);

  return sessions;
}

function queryFileHistory({ file, project, limit = 50 } = {}) {
  if (!file) return [];

  const params = { file: `%${file}%`, limit };
  const conditions = [
    "file_path LIKE @file",
    "tool IN ('Write', 'Edit')"
  ];

  if (project) {
    conditions.push('project = @project');
    params.project = project;
  }

  const sql = `
    SELECT * FROM actions
    WHERE ${conditions.join(' AND ')}
    ORDER BY ts DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all(params);
}

function queryStats({ project, period = '24h' } = {}) {
  // Calculate since timestamp from period
  const periodMap = { '24h': '-1 day', '7d': '-7 days', '30d': '-30 days' };
  const interval = periodMap[period] || '-1 day';

  const params = {};
  let where = `WHERE ts >= datetime('now', '${interval}')`;
  if (project) {
    where += ' AND project = @project';
    params.project = project;
  }

  const total = db.prepare(`SELECT COUNT(*) AS count FROM actions ${where}`).get(params).count;

  const byTool = db.prepare(`
    SELECT tool, COUNT(*) AS count FROM actions ${where} AND tool IS NOT NULL
    GROUP BY tool ORDER BY count DESC
  `).all(params);

  const byAgent = db.prepare(`
    SELECT agent_id, COUNT(*) AS count FROM actions ${where} AND agent_id IS NOT NULL
    GROUP BY agent_id ORDER BY count DESC
  `).all(params);

  const filesChanged = db.prepare(`
    SELECT COUNT(DISTINCT file_path) AS count FROM actions
    ${where} AND file_path IS NOT NULL AND tool IN ('Write', 'Edit')
  `).get(params).count;

  const sessionsCount = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS count FROM actions ${where}
  `).get(params).count;

  return {
    total_actions: total,
    by_tool: byTool.reduce((acc, r) => { acc[r.tool] = r.count; return acc; }, {}),
    by_agent: byAgent.reduce((acc, r) => { acc[r.agent_id] = r.count; return acc; }, {}),
    files_changed: filesChanged,
    sessions: sessionsCount
  };
}

function getLatestActions(project, limit = 20) {
  const params = { limit };
  let where = '';
  if (project) {
    where = 'WHERE project = @project';
    params.project = project;
  }
  return db.prepare(`SELECT * FROM actions ${where} ORDER BY ts DESC LIMIT @limit`).all(params);
}

// ── Cleanup ─────────────────────────────────────────────────────────

function cleanup(daysToKeep = 90) {
  const delActions = db.prepare(`DELETE FROM actions WHERE ts < datetime('now', '-${daysToKeep} days')`).run();
  const delSessions = db.prepare(`DELETE FROM sessions WHERE ended_at < datetime('now', '-${daysToKeep} days')`).run();
  return delActions.changes + delSessions.changes;
}

// ── JSONL Rotation ───────────────────────────────────────────────────

function rotateJsonlFiles(daysToKeep = 30) {
  if (!fs.existsSync(CHANGELOG_DIR)) return 0;

  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const entries = fs.readdirSync(CHANGELOG_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;

    const subDir = path.join(CHANGELOG_DIR, entry.name);
    try {
      const files = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const filePath = path.join(subDir, f);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch { /* skip */ }
      }
      // Remove empty project dirs
      try {
        const remaining = fs.readdirSync(subDir);
        if (remaining.length === 0) fs.rmdirSync(subDir);
      } catch { /* skip */ }
    } catch { /* skip */ }
  }

  // Also clean up legacy flat files
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('_')) continue;
    const filePath = path.join(CHANGELOG_DIR, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch { /* skip */ }
  }

  return deleted;
}

// ── Agent Enrichment ─────────────────────────────────────────────────

function enrichAgentIds() {
  if (!db) return 0;

  // 1. Find all actions with agent_id = 'conductor' or null that have a tool_use_id
  const unattributed = db.prepare(`
    SELECT id, session_id, tool_use_id FROM actions
    WHERE (agent_id IS NULL OR agent_id = 'conductor')
    AND tool_use_id IS NOT NULL
  `).all();

  if (unattributed.length === 0) return 0;

  // 2. Group by session_id
  const bySession = {};
  for (const a of unattributed) {
    if (!bySession[a.session_id]) bySession[a.session_id] = [];
    bySession[a.session_id].push(a);
  }

  // 3. For each session, scan Claude's session directories to find subagent data
  const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME, '.claude/projects');
  const projectDirs = [];
  try {
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(f => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, f)).isDirectory(); } catch { return false; }
    });
    for (const p of projects) {
      projectDirs.push(path.join(CLAUDE_PROJECTS_DIR, p));
    }
  } catch { return 0; }

  // 4. Build tool_use_id → agentType map
  const toolUseToAgent = {};

  for (const sessionId of Object.keys(bySession)) {
    // Find the session directory
    for (const projDir of projectDirs) {
      const sessionDir = path.join(projDir, sessionId, 'subagents');
      if (!fs.existsSync(sessionDir)) continue;

      // Read all agent meta files
      let agentFiles;
      try {
        agentFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.meta.json'));
      } catch { continue; }

      for (const metaFile of agentFiles) {
        const agentId = metaFile.replace('agent-', '').replace('.meta.json', '');
        const jsonlFile = `agent-${agentId}.jsonl`;

        // Read meta for agentType
        let agentType = 'subagent';
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, metaFile), 'utf8'));
          agentType = meta.agentType || 'subagent';
          // Clean up the type: "oh-my-claudecode:executor" → "executor"
          if (agentType.includes(':')) agentType = agentType.split(':').pop();
        } catch { continue; }

        // Read agent JSONL and extract tool_use IDs
        const agentJsonlPath = path.join(sessionDir, jsonlFile);
        if (!fs.existsSync(agentJsonlPath)) continue;

        try {
          const content = fs.readFileSync(agentJsonlPath, 'utf8');
          const lines = content.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              if (entry.type === 'assistant' && entry.message && entry.message.content) {
                for (const block of entry.message.content) {
                  if (block.type === 'tool_use' && block.id) {
                    toolUseToAgent[block.id] = agentType;
                  }
                }
              }
            } catch { /* skip bad lines */ }
          }
        } catch { continue; }
      }

      break; // Found the session dir, no need to check other project dirs
    }
  }

  // 5. Update the database
  const updateAgent = db.prepare('UPDATE actions SET agent_id = @agent_id WHERE id = @id');
  const updateMany = db.transaction((updates) => {
    for (const u of updates) updateAgent.run(u);
  });

  const updates = [];
  for (const a of unattributed) {
    const agentType = toolUseToAgent[a.tool_use_id];
    if (agentType) {
      updates.push({ id: a.id, agent_id: agentType });
    }
  }

  if (updates.length > 0) {
    updateMany(updates);
  }

  return updates.length;
}

module.exports = {
  initDb, closeDb,
  ingestNewEntries,
  queryActions, querySessions, queryFileHistory, queryStats, getLatestActions,
  cleanup, rotateJsonlFiles,
  enrichAgentIds
};
