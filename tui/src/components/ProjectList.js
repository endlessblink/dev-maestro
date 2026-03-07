import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import fs from 'node:fs';
import path from 'node:path';

const h = React.createElement;

const MAESTRO_DIR = process.env.DEV_MAESTRO_DIR || path.join(process.env.HOME, '.dev-maestro');

function loadEnv() {
  const envPath = path.join(MAESTRO_DIR, '.env');
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
  const cfgPath = path.join(MAESTRO_DIR, 'local', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch { return {}; }
}

function getServerPort() {
  const dotEnv = loadEnv();
  const localConfig = loadLocalConfig();
  return process.env.PORT || localConfig.port || dotEnv.PORT || 6010;
}

function loadProjects() {
  const projectsPath = path.join(MAESTRO_DIR, 'projects.json');
  try {
    const raw = fs.readFileSync(projectsPath, 'utf8');
    const data = JSON.parse(raw);
    return data.projects || [];
  } catch { return []; }
}

async function activateProject(name) {
  const port = getServerPort();
  const url = `http://localhost:${port}/api/projects/${encodeURIComponent(name)}/activate`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, { method: 'POST', signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

function ModuleBadge({ name }) {
  const colors = {
    dashboard: 'cyan',
    tui: 'magenta',
    skills: 'green',
    beads: 'yellow',
    health: 'blue',
  };
  const color = colors[name] || 'white';
  return h(Box, { key: name, marginRight: 1 },
    h(Text, { color, dimColor: true }, `[${name}]`)
  );
}

export default function ProjectList({ onBack }) {
  const [projects, setProjects] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState(null); // null | { type: 'loading' | 'success' | 'error', msg: string }

  useEffect(() => {
    const loaded = loadProjects();
    setProjects(loaded);
  }, []);

  const handleActivate = useCallback(async () => {
    const project = projects[cursor];
    if (!project) return;
    setStatus({ type: 'loading', msg: `Switching to ${project.name}...` });
    const result = await activateProject(project.name);
    if (result.success) {
      setStatus({ type: 'success', msg: `Switched to ${project.name}` });
      setTimeout(() => onBack && onBack(), 1200);
    } else {
      setStatus({ type: 'error', msg: `Failed: ${result.error}` });
      setTimeout(() => setStatus(null), 3000);
    }
  }, [projects, cursor, onBack]);

  useInput((input, key) => {
    if (status?.type === 'loading') return;

    if (key.escape || input === 'q') {
      onBack && onBack();
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor(i => Math.min(projects.length - 1, i + 1));
      return;
    }
    if (key.return) {
      handleActivate();
      return;
    }
  });

  const statusColor = status?.type === 'success' ? 'green'
    : status?.type === 'error' ? 'red'
    : 'yellow';

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'double',
    borderColor: 'cyan',
    paddingX: 2,
    paddingY: 1,
    position: 'absolute',
    marginLeft: 4,
    marginTop: 2,
    width: 70,
  },
    h(Box, { flexDirection: 'row', marginBottom: 1 },
      h(Text, { bold: true, color: 'cyan' }, 'Dev Maestro -- Projects'),
      h(Text, { dimColor: true }, `  (${projects.length} registered)`),
    ),

    projects.length === 0
      ? h(Text, { dimColor: true }, 'No projects registered. Run setup to add a project.')
      : h(Box, { flexDirection: 'column' },
          ...projects.map((proj, idx) => {
            const isSelected = idx === cursor;
            const modules = proj.modules || [];
            return h(Box, {
              key: proj.name,
              flexDirection: 'column',
              marginBottom: 1,
              paddingX: 1,
              borderStyle: isSelected ? 'single' : undefined,
              borderColor: isSelected ? 'cyan' : undefined,
            },
              h(Box, { flexDirection: 'row' },
                h(Text, { color: isSelected ? 'cyan' : undefined },
                  `${isSelected ? '> ' : '  '}`
                ),
                h(Text, { bold: isSelected, color: isSelected ? 'cyan' : 'white' }, proj.name),
                proj.addedAt
                  ? h(Text, { dimColor: true }, `  (added ${proj.addedAt})`)
                  : null,
              ),
              h(Box, { flexDirection: 'row', marginLeft: 4 },
                h(Text, { dimColor: true }, proj.root),
              ),
              modules.length > 0
                ? h(Box, { flexDirection: 'row', marginLeft: 4, marginTop: 0 },
                    ...modules.map(m => h(ModuleBadge, { key: m, name: m }))
                  )
                : null,
            );
          })
        ),

    status
      ? h(Box, { marginTop: 1 },
          h(Text, { color: statusColor }, status.msg)
        )
      : null,

    h(Box, { flexDirection: 'row', marginTop: 1, gap: 2 },
      h(Text, { color: 'green', bold: true }, '[Enter] Activate'),
      h(Text, { dimColor: true }, '  [j/k] Navigate  '),
      h(Text, { dimColor: true }, '[q/Esc] Back'),
    ),
  );
}
