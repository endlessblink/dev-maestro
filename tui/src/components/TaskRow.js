import React from 'react';
import { Box, Text } from 'ink';
import { getTypeIcon, getPriorityLabel } from '../lib/colors.js';
import { truncate } from '../lib/truncate.js';

const h = React.createElement;

/**
 * Single-line task row.
 * Format: `{pointer} {icon} {priority} {title...padded} {label} {status}`
 *
 * Props:
 *   issue       - issue object from beads
 *   isSelected  - boolean, highlights row in cyan/bold
 *   isBlocked   - boolean, shows 🔒 indicator
 *   width       - total available column width
 */
export default function TaskRow({ issue, isSelected, isBlocked, width }) {
  const totalWidth = width || 80;

  // Fixed-width segments:
  //   pointer:  2  ("▸ " or "  ")
  //   icon:     2  (emoji + space assumed 2 cols wide)
  //   blocked:  2  ("🔒" or "  ")
  //   priority: 2  ("P0" etc)
  //   space:    1
  //   label:   10  ("[review]  " or "          ")
  //   space:    1
  //   status:  12  right-aligned
  const OVERHEAD = 2 + 2 + 2 + 2 + 1 + 10 + 1 + 12; // = 32
  const titleWidth = Math.max(8, totalWidth - OVERHEAD);

  // --- status indicator (replaces plain pointer) ---
  const indicatorStatus = (issue.status || 'open').toLowerCase();
  let indicator, indicatorColor, indicatorDim = false;

  if (isBlocked) {
    indicator = '⏸ ';
    indicatorColor = 'red';
  } else if (indicatorStatus === 'closed' || indicatorStatus === 'done') {
    indicator = '✓ ';
    indicatorColor = 'green';
  } else if (indicatorStatus === 'in_progress' || indicatorStatus === 'wip') {
    indicator = '● ';
    indicatorColor = 'yellow';
  } else {
    indicator = '○ ';
    indicatorDim = true;
  }

  // --- icon ---
  const icon = getTypeIcon(issue.issue_type);

  // --- priority ---
  const pLabel = getPriorityLabel(
    typeof issue.priority === 'number' ? issue.priority : parseInt(issue.priority ?? '2', 10)
  );
  const pNum = typeof issue.priority === 'number' ? issue.priority : parseInt(issue.priority ?? '2', 10);
  const pColor   = pNum === 0 ? 'red' : pNum === 1 ? 'yellow' : pNum >= 3 ? undefined : undefined;
  const pBold    = pNum <= 1;
  const pDim     = pNum >= 3;

  // --- blocked indicator ---
  const blockedIcon = isBlocked ? '🔒' : '  ';

  // --- title (already includes ref prefix from beads) ---
  const rawTitle = issue.title || '(untitled)';
  const titleText = truncate(rawTitle, titleWidth).padEnd(titleWidth);

  // --- label ---
  // Use the first label/tag, or the first element of issue.labels array
  let firstLabel = '';
  if (Array.isArray(issue.labels) && issue.labels.length > 0) {
    firstLabel = issue.labels[0];
  } else if (typeof issue.labels === 'string' && issue.labels) {
    firstLabel = issue.labels.split(',')[0].trim();
  } else if (issue.tags && Array.isArray(issue.tags) && issue.tags.length > 0) {
    firstLabel = issue.tags[0];
  }
  // Truncate label to 8 chars max so "[label] " fits in 10 cols
  const labelText = firstLabel
    ? `[${truncate(firstLabel, 8)}]`.padEnd(10)
    : ''.padEnd(10);

  // --- status ---
  const status = (issue.status || 'open').toLowerCase();
  let statusColor;
  let statusLabel;
  switch (status) {
    case 'open':
    case 'backlog':
      statusColor = 'gray';
      statusLabel = status;
      break;
    case 'in_progress':
    case 'wip':
      statusColor = 'yellow';
      statusLabel = status === 'in_progress' ? 'in_progress' : 'wip';
      break;
    case 'review':
    case 'inreview':
    case 'in_review':
      statusColor = 'magenta';
      statusLabel = 'review';
      break;
    case 'done':
    case 'closed':
      statusColor = 'green';
      statusLabel = status;
      break;
    default:
      statusColor = 'gray';
      statusLabel = status;
  }
  // Right-align status in 12 chars
  const statusText = statusLabel.slice(0, 12).padStart(12);

  return h(Box, { flexDirection: 'row', width: totalWidth },
    // Status indicator
    h(Text, { color: isSelected ? 'cyan' : indicatorColor, bold: isSelected, dimColor: !isSelected && indicatorDim }, indicator),

    // Icon
    h(Text, null, icon),

    // Blocked indicator
    h(Text, { color: isBlocked ? 'red' : undefined }, blockedIcon),

    // Priority
    h(Text, {
      color: pColor,
      bold: pBold,
      dimColor: pDim,
    }, pLabel, ' '),

    // Title
    h(Text, {
      color: isSelected ? 'cyan' : undefined,
      bold: isSelected,
    }, titleText),

    // Space before label
    h(Text, null, ' '),

    // Label
    h(Text, { color: firstLabel ? 'magenta' : undefined, dimColor: !firstLabel }, labelText),

    // Status
    h(Text, { color: statusColor }, statusText),
  );
}
