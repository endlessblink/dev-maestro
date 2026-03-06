import fs from 'node:fs';
import path from 'node:path';

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
      const headerMatch = line.match(/^###\s+(~~)?((?:TASK|BUG|FEATURE|ROAD|IDEA|ISSUE)-\d+)/);
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
