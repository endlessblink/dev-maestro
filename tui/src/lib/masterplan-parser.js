import fs from 'node:fs';
import path from 'node:path';

const TASK_ID_RE_SOURCE = '[A-Z][A-Z0-9]*-\\d+';

/**
 * Parse MASTER_PLAN.md and return a Map of external_ref → description.
 * @param {string} masterPlanPath - absolute path to MASTER_PLAN.md
 * @returns {Map<string, string>} - map of task ref (e.g. "BUG-1291") to description text
 */
export function parseMasterPlanDescriptions(masterPlanPath) {
  const descriptions = new Map();

  if (!masterPlanPath || !fs.existsSync(masterPlanPath)) {
    return descriptions;
  }

  // Priority-ordered field names to try (first match wins).
  const PRIORITY_FIELDS = new Set([
    'Problem', 'Problem/Opportunity', 'Description', 'Goal',
    'Symptoms', 'Scope', 'Approach', 'Fix', 'Root Cause', 'Root cause', 'Summary',
  ]);

  // Metadata-only fields — skip when scanning for a fallback line.
  const SKIP_FIELDS = new Set([
    'Priority', 'Status', 'Owner', 'Assignee', 'Created', 'Updated',
    'Files', 'Tags', 'Labels', 'Depends', 'Blocks', 'Progress',
  ]);

  // Matches **FieldName** optionally followed by anything before an optional colon.
  // Group 1 = field name, Group 2 = inline value after colon (may be empty/undefined).
  // The [^:]* between the closing ** and : allows for "(parenthetical clarification)".
  const FIELD_RE = /^\*\*([\w \/]+)\*\*[^:]*:?\s*(.*)?/;

  try {
    const content = fs.readFileSync(masterPlanPath, 'utf8');
    const lines = content.split('\n');

    let currentRef = null;
    let inSection = false;
    let descriptionLines = [];
    let foundDescription = false;

    const saveCurrentTask = () => {
      if (currentRef && descriptionLines.length > 0) {
        descriptions.set(currentRef, descriptionLines.join(' ').trim());
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match task section headers: ### TASK-123 or ### ~~TASK-123~~
      const headerMatch = line.match(new RegExp(`^###\\s+(~~)?(${TASK_ID_RE_SOURCE})`));
      if (headerMatch) {
        saveCurrentTask();
        currentRef = headerMatch[2];
        inSection = true;
        descriptionLines = [];
        foundDescription = false;
        continue;
      }

      // Any ## or # heading (but not a task header) closes the current task section
      if (inSection && /^#{1,3}\s/.test(line) && !headerMatch) {
        saveCurrentTask();
        currentRef = null;
        inSection = false;
        descriptionLines = [];
        foundDescription = false;
        continue;
      }

      if (!inSection || !currentRef || foundDescription) continue;

      const fieldMatch = line.match(FIELD_RE);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        const inlineValue = (fieldMatch[2] || '').trim();

        if (PRIORITY_FIELDS.has(fieldName)) {
          const collected = [];

          if (inlineValue) {
            collected.push(inlineValue);
          }

          // Collect continuation / list lines (up to 5 total lines)
          for (let j = i + 1; j < lines.length && collected.length < 5; j++) {
            const next = lines[j].trim();
            if (!next) break;  // blank line ends the value
            if (next.startsWith('**') || next.startsWith('###') || next.startsWith('---')) break;
            // Strip leading list markers (1. 2. - *)
            const cleaned = next.replace(/^[\d]+\.\s*/, '').replace(/^[-*]\s*/, '');
            // Strip inline bold markers
            collected.push(cleaned.replace(/\*\*/g, ''));
          }

          if (collected.length > 0) {
            descriptionLines = collected;
            foundDescription = true;
          }
          continue;
        }

        // Skip metadata fields
        if (SKIP_FIELDS.has(fieldName)) continue;
      }

      // Fallback: use first non-empty, non-metadata, non-separator line
      if (!foundDescription) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Skip separators, code fences, HTML, tables
        if (trimmed.startsWith('---') || trimmed.startsWith('```') ||
            trimmed.startsWith('<') || trimmed.startsWith('|')) continue;

        // Skip lines that are only a metadata bold field
        const boldOnlyMatch = trimmed.match(/^\*\*([\w \/]+)\*\*\s*$/);
        if (boldOnlyMatch && SKIP_FIELDS.has(boldOnlyMatch[1])) continue;

        // Check if this is a bold field we should skip
        const boldFieldMatch = trimmed.match(/^\*\*([\w \/]+)\*\*[^:]*:/);
        if (boldFieldMatch && SKIP_FIELDS.has(boldFieldMatch[1])) continue;

        descriptionLines = [trimmed.replace(/\*\*/g, '')];
        foundDescription = true;
      }
    }

    // Flush the last task
    saveCurrentTask();
  } catch (err) {
    // Silently fail — descriptions are optional enrichment
  }

  return descriptions;
}

/**
 * Parse MASTER_PLAN.md table rows AND section headers into full task objects.
 * This is the standalone fallback when neither the server nor bd binary is available.
 * Returns an array in the same shape as transformTask() output from bd-client.js.
 * @param {string} masterPlanPath - absolute path to MASTER_PLAN.md
 * @returns {Array<Object>} - array of task objects
 */
export function parseMasterPlanTasks(masterPlanPath) {
  if (!masterPlanPath || !fs.existsSync(masterPlanPath)) return [];

  const content = fs.readFileSync(masterPlanPath, 'utf8');
  const lines = content.split('\n');
  const tasks = new Map(); // id → task object (dedup by id)

  // Priority string → numeric
  const priorityMap = { P0: 0, P1: 1, P2: 2, P3: 3 };
  function parsePriority(str) {
    const m = str.match(/P[0-3]/);
    return m ? (priorityMap[m[0]] ?? 2) : 2;
  }

  // Detect status from text
  function parseStatus(text) {
    if (/✅\s*(DONE|Done)|~~/.test(text)) return 'closed';
    if (/🔄|IN.?PROGRESS/i.test(text)) return 'in_progress';
    if (/👀|REVIEW/i.test(text)) return 'inreview';
    if (/⏸️|PAUSED/i.test(text)) return 'open';
    if (/📋|PLANNED/i.test(text)) return 'open';
    return 'open';
  }

  // ── Parse table rows: | **ID** | **Priority** | **Title/Status** |
  // Format varies but ID is always PREFIX-NNN.
  const TABLE_RE = new RegExp(`\\|\\s*(?:~~)?\\*?\\*?(${TASK_ID_RE_SOURCE})\\*?\\*?(?:~~)?\\s*\\|([^|]*)\\|([^|]*)\\|?`);
  for (const line of lines) {
    const m = line.match(TABLE_RE);
    if (!m) continue;
    const id = m[1];
    const col2 = m[2].trim();
    const col3 = m[3].trim();

    // Determine which column has priority and which has the title
    // Common formats:
    //   | **ID** | **P2** | **Title text** |
    //   | ID | P2 | Title text |
    let priority = 2;
    let title = '';
    let statusText = '';

    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 6 && /P[0-3]/.test(cells[4])) {
      // ID | Lane | Task | Status | Priority | Deps
      priority = parsePriority(cells[4]);
      title = cells[2].replace(/\*\*/g, '').replace(/[📋🔄👀⏸️✅]/g, '').trim();
      statusText = cells[3];
    } else if (/P[0-3]/.test(col2)) {
      priority = parsePriority(col2);
      // col3 has the title + status
      title = col3.replace(/\*\*/g, '').replace(/[📋🔄👀⏸️✅]/g, '').trim();
      statusText = col3;
    } else {
      // Maybe col2 is title, col3 is status
      title = col2.replace(/\*\*/g, '').replace(/[📋🔄👀⏸️✅]/g, '').trim();
      statusText = col2 + col3;
      const pm = col3.match(/P[0-3]/);
      if (pm) priority = priorityMap[pm[0]] ?? 2;
    }

    // Clean up title — remove status markers, dates, parens at end
    title = title
      .replace(/\((?:📋|🔄|👀|⏸️|✅)\s*(?:PLANNED|IN PROGRESS|REVIEW|PAUSED|DONE).*?\)/gi, '')
      .replace(/\(✅ DONE[^)]*\)/gi, '')
      .replace(/~~([^~]+)~~/g, '$1')
      .trim();

    // Remove trailing date like "2026-03-08"
    title = title.replace(/\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();

    if (!title) continue;

    const status = parseStatus(statusText + line);
    const isDone = /~~/.test(line) || status === 'closed';
    const hasReview = status === 'inreview';

    tasks.set(id, {
      id,
      title,
      status: isDone ? 'closed' : status,
      priority,
      issue_type: id.match(/^([A-Z]+)-/)?.[1]?.toLowerCase() || 'task',
      created_at: '',
      updated_at: '',
      closed_at: isDone ? new Date().toISOString() : '',
      labels: hasReview ? ['review'] : [],
      external_ref: id,
    });
  }

  // ── Also parse ### section headers (they have richer status info)
  const HEADER_RE = new RegExp(`^###\\s+(~~)?(${TASK_ID_RE_SOURCE})(?:~~)?(?:[:\\s\\-–—]+)(.+)`);
  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(HEADER_RE);
    if (!hm) continue;
    const isDone = !!hm[1];
    const id = hm[2];
    const rest = hm[3];

    // Extract title (before status parens)
    let title = rest.replace(/\((?:📋|🔄|👀|⏸️|✅)[^)]*\)/gi, '').replace(/\*\*/g, '').trim();
    const status = isDone ? 'closed' : parseStatus(rest);

    // Look for priority on next lines
    let priority = 2;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const pm = lines[j].match(/P([0-3])/);
      if (pm) { priority = parseInt(pm[1], 10); break; }
    }

    // Only add if not already from table (table rows are authoritative for status)
    if (!tasks.has(id)) {
      tasks.set(id, {
        id,
        title,
        status,
        priority,
        issue_type: id.match(/^([A-Z]+)-/)?.[1]?.toLowerCase() || 'task',
        created_at: '',
        updated_at: '',
        closed_at: isDone ? new Date().toISOString() : '',
        labels: status === 'inreview' ? ['review'] : [],
        external_ref: id,
      });
    }
  }

  return Array.from(tasks.values());
}

/**
 * Get the MASTER_PLAN.md path from environment or .env file.
 * Priority: MASTER_PLAN_PATH env → auto-detect from caller's CWD → .env fallback.
 * @returns {string|null}
 */
export function getMasterPlanPath() {
  // 1. Explicit env var takes priority
  if (process.env.MASTER_PLAN_PATH) return process.env.MASTER_PLAN_PATH;

  // 2. Auto-detect from caller's working directory (set by wrapper script)
  const cwd = process.env.MAESTRO_CWD;
  if (cwd) {
    const candidates = [
      path.join(cwd, 'docs', 'MASTER_PLAN.md'),
      path.join(cwd, 'MASTER_PLAN.md'),
      path.join(cwd, 'planning', 'MASTER_PLAN.md'),
      path.join(cwd, 'doc', 'MASTER_PLAN.md'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 3. Fallback: .env file in ~/.dev-maestro/
  const envPath = path.join(process.env.HOME, '.dev-maestro', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('MASTER_PLAN_PATH=')) {
        return trimmed.slice('MASTER_PLAN_PATH='.length);
      }
    }
  }

  return null;
}
