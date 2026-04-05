'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Directories to skip when walking the file tree.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  '.env',
  'venv',
]);

/**
 * Files whose presence marks a directory as a project root,
 * even without a MASTER_PLAN.md.
 * Ordered by specificity — first match wins.
 */
const PROJECT_MARKERS = [
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'build.gradle',
  'pom.xml',
  'Makefile',
  'CMakeLists.txt',
  'setup.py',
  'composer.json',
  'Gemfile',
  'pubspec.yaml',
  'deno.json',
  'bun.lockb',
];

/**
 * Subdirectory names that indicate MASTER_PLAN.md lives one level below the
 * actual project root (e.g. the file is at <root>/docs/MASTER_PLAN.md).
 */
const DOCS_SUBDIRS = new Set(['docs', 'planning', '.github', 'doc']);

/**
 * Return true if a directory entry should be skipped during the walk.
 * @param {string} basename
 * @returns {boolean}
 */
function shouldSkipDir(basename) {
  if (SKIP_DIRS.has(basename)) return true;
  // Skip hidden dirs except .github
  if (basename.startsWith('.') && basename !== '.github') return true;
  return false;
}

/**
 * Walk a directory tree up to `maxDepth` and collect MASTER_PLAN.md paths
 * and directories containing project marker files.
 * Uses synchronous fs operations with try/catch to handle permission errors.
 *
 * @param {string} dir       - Directory to walk
 * @param {number} depth     - Current depth (starts at 0)
 * @param {number} maxDepth
 * @param {string[]} masterPlanResults - Accumulator for found MASTER_PLAN.md paths
 * @param {Map<string,string>} markerResults - Map of root -> first marker filename
 * @param {Set<string>} visited
 */
function walkDir(dir, depth, maxDepth, masterPlanResults, markerResults, visited) {
  if (depth > maxDepth) return;

  // Cycle detection: resolve real path and check visited set
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
  } catch (_) {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    // Permission error or not a directory — skip silently
    return;
  }

  const entrySet = new Set(entries);

  // Check for MASTER_PLAN.md
  if (entrySet.has('MASTER_PLAN.md')) {
    const fullPath = path.join(dir, 'MASTER_PLAN.md');
    try {
      if (fs.statSync(fullPath).isFile()) {
        masterPlanResults.push(fullPath);
      }
    } catch (_) { /* skip */ }
  }

  // Check for project marker files (only if this dir has a .git — otherwise
  // it's likely a subdirectory/package inside a larger project)
  if (entrySet.has('.git') && !markerResults.has(dir)) {
    for (const marker of PROJECT_MARKERS) {
      if (entrySet.has(marker)) {
        try {
          if (fs.statSync(path.join(dir, marker)).isFile()) {
            markerResults.set(dir, marker);
            break;
          }
        } catch (_) { /* skip */ }
      }
    }
    // .git alone (no other marker) still counts as a project
    if (!markerResults.has(dir)) {
      markerResults.set(dir, '.git');
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (entry === 'MASTER_PLAN.md') continue;
    if (shouldSkipDir(entry)) continue;

    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }

    if (stat.isDirectory()) {
      walkDir(fullPath, depth + 1, maxDepth, masterPlanResults, markerResults, visited);
    }
  }
}

/**
 * Recursively scan directories to find projects.
 *
 * Discovery strategy (in priority order):
 * 1. MASTER_PLAN.md — the classic Watchpost project marker
 * 2. .git + project marker file (package.json, Cargo.toml, etc.)
 *
 * Projects found via marker files get `masterPlan: null` until the user
 * creates a MASTER_PLAN.md for them.
 *
 * @param {string[]} scanPaths - Root directories to scan
 * @param {number}   maxDepth  - Maximum directory depth (default 5)
 * @returns {Array<{name: string, root: string, masterPlan: string|null}>}
 */
function scanForProjects(scanPaths, maxDepth = 5) {
  if (!Array.isArray(scanPaths) || scanPaths.length === 0) return [];

  const masterPlanPaths = [];
  const markerRoots = new Map(); // root -> marker filename

  for (const scanPath of scanPaths) {
    const resolved = path.resolve(scanPath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (_) {
      continue;
    }
    if (!stat.isDirectory()) continue;

    walkDir(resolved, 0, maxDepth, masterPlanPaths, markerRoots, new Set());
  }

  // Build project entries from MASTER_PLAN.md discoveries (highest priority)
  const seenRoots = new Map();
  for (const masterPlanPath of masterPlanPaths) {
    const root = deriveProjectRoot(masterPlanPath);
    if (!seenRoots.has(root)) {
      seenRoots.set(root, { root, masterPlan: masterPlanPath });
    }
  }

  // Add marker-only projects (those without a MASTER_PLAN.md)
  for (const [root] of markerRoots) {
    if (!seenRoots.has(root)) {
      seenRoots.set(root, { root, masterPlan: null });
    }
  }

  const dedupedProjects = Array.from(seenRoots.values());

  // Resolve names, handling duplicates
  const usedNames = new Map();
  const result = [];

  for (const p of dedupedProjects) {
    const name = deriveProjectName(p.root, usedNames);
    usedNames.set(path.basename(p.root), (usedNames.get(path.basename(p.root)) || 0) + 1);
    result.push({ name, root: p.root, masterPlan: p.masterPlan });
  }

  return result;
}

/**
 * Derive the project root from a MASTER_PLAN.md path.
 *
 * If MASTER_PLAN.md lives inside docs/, planning/, .github/, or doc/ then
 * its grandparent directory is the project root; otherwise the containing
 * directory is the project root.
 *
 * @param {string} masterPlanPath - Absolute path to MASTER_PLAN.md
 * @returns {string} Absolute path to project root
 */
function deriveProjectRoot(masterPlanPath) {
  const containingDir = path.dirname(masterPlanPath);
  const basename = path.basename(containingDir);

  if (DOCS_SUBDIRS.has(basename)) {
    return path.dirname(containingDir);
  }

  return containingDir;
}

/**
 * Derive a project name from the project root path.
 *
 * Uses the basename of the root directory.  If `existingNames` already
 * contains an entry for that basename (meaning a collision), the parent
 * directory name is prepended: "parentdir/my-app".
 *
 * @param {string} projectRoot   - Absolute path to the project root
 * @param {Map<string,number>}   existingNames - Map of basename -> usage count
 *   (tracks how many times a given simple name has already been used)
 * @returns {string}
 */
function deriveProjectName(projectRoot, existingNames) {
  const base = path.basename(projectRoot);

  if (!existingNames || existingNames.get(base) == null || existingNames.get(base) === 0) {
    return base;
  }

  // Collision: prepend parent dir name
  const parent = path.basename(path.dirname(projectRoot));
  return `${parent}/${base}`;
}

/**
 * Sync discovered projects with projects.json.
 *
 * - Reads the existing projects.json (creates it if missing)
 * - Scans for new projects in `scanPaths`
 * - Registers any not already in projects.json (matched by root path)
 * - Does NOT overwrite manual entries
 * - Optionally removes entries whose root no longer exists on disk
 *
 * @param {string[]} scanPaths        - Directories to scan
 * @param {string}   projectsJsonPath - Absolute path to projects.json
 * @param {object}   options
 * @param {number}   [options.maxDepth=5]
 * @param {boolean}  [options.cleanMissing=false] - Remove stale entries
 * @returns {{ added: Array, removed: Array, existing: number, total: number }}
 */
function syncDiscoveredProjects(scanPaths, projectsJsonPath, options = {}) {
  const { maxDepth = 5, cleanMissing = false } = options;

  // 1. Read existing projects.json
  let projectsData = { projects: [] };

  if (fs.existsSync(projectsJsonPath)) {
    try {
      const raw = fs.readFileSync(projectsJsonPath, 'utf8');
      projectsData = JSON.parse(raw);
      if (!Array.isArray(projectsData.projects)) {
        projectsData.projects = [];
      }
    } catch (err) {
      throw new Error(`Failed to parse ${projectsJsonPath}: ${err.message}`);
    }
  }

  const existing = projectsData.projects;

  // Build a Set of known roots for fast lookup
  const knownRoots = new Set(existing.map((p) => p.root));

  // 2. Scan for projects
  const discovered = scanForProjects(scanPaths, maxDepth);

  // 3. Build name collision map from existing names + newly added names
  //    so deriveProjectName can avoid duplicates across the whole file
  const nameUsage = new Map();
  for (const p of existing) {
    const base = path.basename(p.root);
    nameUsage.set(base, (nameUsage.get(base) || 0) + 1);
  }

  // 4. Determine additions
  const added = [];
  const today = new Date().toISOString().slice(0, 10);

  let updated = false;

  for (const project of discovered) {
    if (knownRoots.has(project.root)) {
      // Already registered — but backfill masterPlan if it was missing
      if (project.masterPlan) {
        const entry = existing.find((p) => p.root === project.root);
        if (entry && !entry.masterPlan) {
          entry.masterPlan = project.masterPlan;
          updated = true;
        }
      }
      continue;
    }

    // Resolve a non-colliding name in the context of the full file
    const base = path.basename(project.root);
    const resolvedName =
      (nameUsage.get(base) || 0) > 0
        ? `${path.basename(path.dirname(project.root))}/${base}`
        : base;

    nameUsage.set(base, (nameUsage.get(base) || 0) + 1);

    const newEntry = {
      name: resolvedName,
      root: project.root,
      masterPlan: project.masterPlan || null,
      modules: [],
      source: 'auto-discovered',
      addedAt: today,
    };

    existing.push(newEntry);
    added.push(newEntry);
    knownRoots.add(project.root);
  }

  // 5. Optionally remove entries whose root no longer exists
  const removed = [];

  if (cleanMissing) {
    const kept = [];
    for (const entry of projectsData.projects) {
      const rootExists = fs.existsSync(entry.root);
      if (!rootExists) {
        removed.push(entry);
      } else {
        kept.push(entry);
      }
    }
    projectsData.projects = kept;
  }

  const total = projectsData.projects.length;
  const existingCount = total - added.length;

  // 6. Write updated projects.json only if something changed
  if (added.length > 0 || removed.length > 0 || updated) {
    try {
      const dir = path.dirname(projectsJsonPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(projectsJsonPath, JSON.stringify(projectsData, null, 2) + '\n', 'utf8');
    } catch (err) {
      throw new Error(`Failed to write ${projectsJsonPath}: ${err.message}`);
    }
  }

  return {
    added,
    removed,
    existing: existingCount,
    total,
  };
}

module.exports = {
  scanForProjects,
  deriveProjectRoot,
  deriveProjectName,
  syncDiscoveredProjects,
};
