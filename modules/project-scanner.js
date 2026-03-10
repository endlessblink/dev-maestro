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
 * Walk a directory tree up to `maxDepth` and collect all MASTER_PLAN.md paths.
 * Uses synchronous fs operations with try/catch to handle permission errors.
 *
 * @param {string} dir     - Directory to walk
 * @param {number} depth   - Current depth (starts at 0)
 * @param {number} maxDepth
 * @param {string[]} results - Accumulator for found paths
 */
function walkDir(dir, depth, maxDepth, results, visited) {
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

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);

    // Check for the target file first (cheap string compare)
    if (entry === 'MASTER_PLAN.md') {
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (_) {
        continue;
      }
      if (stat.isFile()) {
        results.push(fullPath);
      }
      continue;
    }

    // Skip known noisy dirs before calling statSync
    if (shouldSkipDir(entry)) continue;

    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (_) {
      continue;
    }

    if (stat.isDirectory()) {
      walkDir(fullPath, depth + 1, maxDepth, results, visited);
    }
  }
}

/**
 * Recursively scan directories to find MASTER_PLAN.md files.
 *
 * @param {string[]} scanPaths - Root directories to scan
 * @param {number}   maxDepth  - Maximum directory depth (default 5)
 * @returns {Array<{name: string, root: string, masterPlan: string}>}
 */
function scanForProjects(scanPaths, maxDepth = 5) {
  if (!Array.isArray(scanPaths) || scanPaths.length === 0) return [];

  const foundPaths = [];

  for (const scanPath of scanPaths) {
    const resolved = path.resolve(scanPath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (_) {
      // Path doesn't exist or is inaccessible — skip
      continue;
    }
    if (!stat.isDirectory()) continue;

    walkDir(resolved, 0, maxDepth, foundPaths, new Set());
  }

  // Derive root + name for each found plan
  const rawProjects = foundPaths.map((masterPlanPath) => ({
    masterPlan: masterPlanPath,
    root: deriveProjectRoot(masterPlanPath),
  }));

  // Deduplicate by root (multiple docs/ subfolders could theoretically match)
  const seenRoots = new Map();
  for (const p of rawProjects) {
    if (!seenRoots.has(p.root)) {
      seenRoots.set(p.root, p);
    }
  }

  const dedupedProjects = Array.from(seenRoots.values());

  // Resolve names, handling duplicates
  const usedNames = new Map(); // name -> count
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

  for (const project of discovered) {
    if (knownRoots.has(project.root)) {
      // Already registered — leave it untouched
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
      masterPlan: project.masterPlan,
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
  if (added.length > 0 || removed.length > 0) {
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
