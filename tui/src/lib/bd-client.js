import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// BD_PATH resolution — mirrors server.js pattern
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

// Load .env from ~/.dev-maestro/.env (same as server.js)
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

// CWD resolution — from caller's directory, MASTER_PLAN_PATH env, or .env file
const PROJECT_ROOT = (() => {
  // 1. Auto-detect from caller's working directory (set by wrapper script)
  //    Only use if a MASTER_PLAN.md or .beads/ is actually found there.
  const cwd = process.env.MAESTRO_CWD;
  if (cwd) {
    // Check for .beads directory (beads project)
    if (fs.existsSync(path.join(cwd, '.beads'))) {
      return cwd;
    }
    // Check for MASTER_PLAN.md to derive project root
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
    // Nothing found in CWD — fall through to .env
  }

  // 2. Explicit env var or .env file
  const dotEnv = loadEnv();
  const mp = process.env.MASTER_PLAN_PATH || dotEnv.MASTER_PLAN_PATH;
  if (mp) {
    const planDir = path.dirname(mp);
    const dirName = path.basename(planDir);
    if (['docs', 'doc', 'planning', '.github'].includes(dirName)) {
      return path.dirname(planDir);
    }
    return planDir;
  }
  // Last fallback: parent of dev-maestro dir
  return path.resolve(process.env.HOME, '.dev-maestro', '..');
})();

// Resolve .beads directory — bd needs BEADS_DIR to find the database
// when not running from the project directory itself.
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

/**
 * Run a bd command with --json flag, return parsed JSON or null.
 */
export function bd(args) {
  try {
    const result = execSync(`${BD_PATH} ${args} --json`, EXEC_OPTS);
    return JSON.parse(result);
  } catch (err) {
    return null;
  }
}

/**
 * Run a bd command without --json (for mutations).
 * Returns { success: boolean, output: string }
 */
export function bdExec(args) {
  try {
    const output = execSync(`${BD_PATH} ${args}`, EXEC_OPTS);
    return { success: true, output: output.trim() };
  } catch (err) {
    return { success: false, output: err.stderr?.toString() || err.message };
  }
}
