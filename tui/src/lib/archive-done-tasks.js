import fs from 'node:fs';
import path from 'node:path';

/**
 * Archive completed tasks from MASTER_PLAN.md to MASTER_PLAN_ARCHIVE.md
 *
 * Moves detail blocks (### ~~TASK-XXX~~: ... sections) for tasks completed
 * more than N days ago. Keeps summary table rows in the main file.
 *
 * Usage from maestro CLI:
 *   maestro archive              # Archive tasks done >14 days ago
 *   maestro archive --days=30    # Archive tasks done >30 days ago
 *   maestro archive --dry-run    # Preview without writing
 */

export function archiveDoneTasks(masterPlanPath, options = {}) {
  const { dryRun = false, daysThreshold = 14 } = options;

  const archivePath = masterPlanPath.replace(/MASTER_PLAN\.md$/, 'MASTER_PLAN_ARCHIVE.md');
  const now = new Date();
  const cutoffDate = new Date(now.getTime() - daysThreshold * 24 * 60 * 60 * 1000);

  console.log(`\n📦 MASTER_PLAN Archive Tool`);
  console.log(`─────────────────────────────`);
  console.log(`File: ${masterPlanPath}`);
  console.log(`Threshold: ${daysThreshold} days (before ${cutoffDate.toISOString().split('T')[0]})`);
  console.log(`Mode: ${dryRun ? '🔍 DRY RUN' : '✏️  WRITE'}\n`);

  if (!fs.existsSync(masterPlanPath)) {
    console.error(`❌ MASTER_PLAN.md not found at: ${masterPlanPath}`);
    return { archived: 0, error: 'file not found' };
  }

  const content = fs.readFileSync(masterPlanPath, 'utf8');
  const lines = content.split('\n');

  // Find all DONE detail sections
  const sections = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const headerMatch = line.match(/^### ~~((?:TASK|BUG|FEATURE|ISSUE|ROAD|IDEA|INQUIRY)-\d+)~~:.*\(.*(?:DONE|FIXED|COMPLETE|✅).*\)/i);

    if (headerMatch) {
      const taskId = headerMatch[1];
      const startLine = i;

      let endLine = i + 1;
      while (endLine < lines.length) {
        if (/^#{2,3} /.test(lines[endLine]) && endLine > startLine) break;
        endLine++;
      }

      while (endLine > startLine + 1 && lines[endLine - 1].trim() === '') endLine--;

      const sectionText = lines.slice(startLine, endLine).join('\n');
      let completionDate = null;

      const dateSearchLines = lines.slice(startLine, Math.min(startLine + 5, endLine)).join('\n');
      const dateMatch = dateSearchLines.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) completionDate = new Date(dateMatch[1]);

      sections.push({ taskId, startLine, endLine, completionDate, text: sectionText });
      i = endLine;
    } else {
      i++;
    }
  }

  console.log(`Found ${sections.length} DONE detail sections total.\n`);

  const toArchive = [];
  const kept = [];
  const noDate = [];

  for (const section of sections) {
    if (section.completionDate && section.completionDate < cutoffDate) {
      toArchive.push(section);
    } else if (section.completionDate && section.completionDate >= cutoffDate) {
      kept.push(section);
    } else {
      noDate.push(section);
      toArchive.push(section);
    }
  }

  console.log(`📊 Breakdown:`);
  console.log(`  Archiving (older than ${daysThreshold} days): ${toArchive.length - noDate.length}`);
  console.log(`  Archiving (no date found):       ${noDate.length}`);
  console.log(`  Keeping (recent):                ${kept.length}`);
  console.log('');

  if (toArchive.length === 0) {
    console.log('✅ Nothing to archive. All DONE tasks are recent.\n');
    return { archived: 0 };
  }

  console.log(`📋 Tasks to archive:`);
  for (const s of toArchive) {
    const dateStr = s.completionDate ? s.completionDate.toISOString().split('T')[0] : 'no date';
    const lineCount = s.endLine - s.startLine;
    console.log(`  ${s.taskId.padEnd(16)} ${dateStr.padEnd(12)} (${lineCount} lines)`);
  }
  console.log('');

  if (dryRun) {
    const totalLines = toArchive.reduce((sum, s) => sum + (s.endLine - s.startLine), 0);
    console.log('🔍 DRY RUN — no files modified.\n');
    console.log(`Would archive ${toArchive.length} sections (~${totalLines} lines).\n`);
    return { archived: 0, wouldArchive: toArchive.length };
  }

  // Build archive content
  const archiveHeader = `# MASTER_PLAN Archive\n\n> Completed tasks archived from [MASTER_PLAN.md](./MASTER_PLAN.md).\n> Summary table entries remain in the main file.\n>\n> Last archived: ${now.toISOString().split('T')[0]}\n\n---\n\n`;

  let existingArchive = '';
  if (fs.existsSync(archivePath)) {
    existingArchive = fs.readFileSync(archivePath, 'utf8');
    const firstSection = existingArchive.indexOf('\n### ');
    if (firstSection !== -1) existingArchive = existingArchive.slice(firstSection);
    else existingArchive = '';
  }

  const newArchiveContent = toArchive.map(s => s.text).join('\n\n');
  const fullArchive = archiveHeader + newArchiveContent + (existingArchive ? '\n\n' + existingArchive : '') + '\n';

  // Remove archived sections from main file
  const linesToRemove = new Set();
  for (const section of toArchive.sort((a, b) => b.startLine - a.startLine)) {
    let removeEnd = section.endLine;
    while (removeEnd < lines.length && lines[removeEnd].trim() === '') removeEnd++;
    for (let j = section.startLine; j < removeEnd; j++) linesToRemove.add(j);
  }

  const newLines = lines.filter((_, idx) => !linesToRemove.has(idx));

  // Clean consecutive blank lines
  const cleanedLines = [];
  let blankCount = 0;
  for (const line of newLines) {
    if (line.trim() === '') {
      blankCount++;
      if (blankCount <= 2) cleanedLines.push(line);
    } else {
      blankCount = 0;
      cleanedLines.push(line);
    }
  }

  fs.writeFileSync(archivePath, fullArchive, 'utf8');
  fs.writeFileSync(masterPlanPath, cleanedLines.join('\n'), 'utf8');

  const originalSize = Buffer.byteLength(content, 'utf8');
  const newSize = Buffer.byteLength(cleanedLines.join('\n'), 'utf8');
  const reduction = ((1 - newSize / originalSize) * 100).toFixed(1);

  console.log(`✅ Archived ${toArchive.length} sections to ${path.basename(archivePath)}`);
  console.log(`📉 MASTER_PLAN.md: ${(originalSize / 1024).toFixed(0)}KB → ${(newSize / 1024).toFixed(0)}KB (${reduction}% reduction)`);
  console.log(`📁 Archive: ${(Buffer.byteLength(fullArchive, 'utf8') / 1024).toFixed(0)}KB\n`);

  return { archived: toArchive.length, reduction };
}
