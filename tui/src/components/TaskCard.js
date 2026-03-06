import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from '../lib/truncate.js';

const h = React.createElement;

/**
 * agtx-style task card.
 *
 * Layout:
 *   ┌────────────────────────────────────────────┐
 *   │ ✓ BUG-1291: Timer & Context Menu...        │
 *   │  Multi-line description text wrapped to    │
 *   │  fit the available width, up to 5 lines.   │
 *   │                                    owner   │
 *   │  [label1] [label2]                         │
 *   │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
 *   └────────────────────────────────────────────┘
 *
 * Props:
 *   issue      — task/issue object
 *   isSelected — highlights border cyan
 *   isBlocked  — overrides indicator, border red (unless selected)
 *   width      — total card width including border chars
 */
export default function TaskCard({ issue, isSelected, isBlocked, width }) {
  const totalWidth = width || 60;
  // Ink's borderStyle:'single' consumes 2 chars (left+right border) and also
  // applies 1 char of internal padding on each side by default — so content
  // area is totalWidth - 4.  We replicate the 1-char left padding manually via
  // a leading space on each content line, so innerWidth = totalWidth - 2.
  const innerWidth = Math.max(10, totalWidth - 2);
  // Available text width inside the 1-char left-pad
  const textWidth = innerWidth - 1;

  // ── Status indicator ──────────────────────────────────────────────────────
  const status = (issue.status || 'open').toLowerCase();
  let indicator, indicatorColor, indicatorDim;
  if (isBlocked) {
    indicator = '⏸';
    indicatorColor = 'red';
    indicatorDim = false;
  } else if (status === 'done' || status === 'closed') {
    indicator = '✓';
    indicatorColor = 'green';
    indicatorDim = false;
  } else if (status === 'in_progress' || status === 'wip') {
    indicator = '●';
    indicatorColor = 'yellow';
    indicatorDim = false;
  } else {
    indicator = '○';
    indicatorColor = undefined;
    indicatorDim = true;
  }

  // ── Title ─────────────────────────────────────────────────────────────────
  // indicator(1) + space(1) = 2 chars consumed; rest for title
  const titleAvail = Math.max(4, textWidth - 2);
  const rawTitle = issue.title || '(untitled)';
  const titleText = truncate(rawTitle, titleAvail);

  // ── Description (word-wrap, up to 5 lines, skip if empty) ─────────────────
  const rawDesc = (issue.description || '').trim();
  const descLines = [];
  if (rawDesc) {
    const words = rawDesc.replace(/\r?\n/g, ' ').split(/\s+/).filter(Boolean);
    const maxLines = 5;
    const lineWidth = textWidth; // 1-char pad already in textWidth
    let line = '';
    for (const word of words) {
      if (descLines.length >= maxLines) break;
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > lineWidth) {
        if (line) {
          descLines.push(line);
          line = word.length > lineWidth ? truncate(word, lineWidth) : word;
        } else {
          descLines.push(truncate(word, lineWidth));
          line = '';
        }
      } else {
        line = candidate;
      }
    }
    if (line && descLines.length < maxLines) {
      descLines.push(line);
    }
  }

  // ── Labels ────────────────────────────────────────────────────────────────
  let labelsArr = [];
  if (Array.isArray(issue.labels) && issue.labels.length > 0) {
    labelsArr = issue.labels;
  } else if (typeof issue.labels === 'string' && issue.labels) {
    labelsArr = issue.labels.split(',').map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(issue.tags) && issue.tags.length > 0) {
    labelsArr = issue.tags;
  }
  const labelsStr = labelsArr.slice(0, 3).map(l => `[${truncate(l, 12)}]`).join(' ');

  // ── Owner ─────────────────────────────────────────────────────────────────
  const rawOwner = issue.owner || issue.assignee || '';
  const owner = rawOwner.includes('@') ? rawOwner.split('@')[0] : rawOwner;

  // ── Status bar color ──────────────────────────────────────────────────────
  let barColor;
  switch (status) {
    case 'in_progress':
    case 'wip':
      barColor = 'yellow'; break;
    case 'review':
    case 'inreview':
    case 'in_review':
      barColor = 'magenta'; break;
    case 'done':
    case 'closed':
      barColor = 'green'; break;
    default:
      barColor = 'gray'; break;
  }
  if (isBlocked) barColor = 'red';

  // ── Border color ──────────────────────────────────────────────────────────
  let borderColor;
  if (isSelected) {
    borderColor = 'cyan';
  } else if (isBlocked) {
    borderColor = 'red';
  } else {
    const type = (issue.issue_type || '').toLowerCase();
    switch (type) {
      case 'bug':     borderColor = 'red';     break;
      case 'feature': borderColor = 'green';   break;
      case 'task':    borderColor = 'cyan';    break;
      case 'epic':    borderColor = 'magenta'; break;
      default:        borderColor = 'gray';    break;
    }
  }

  // ── Status bar ─────────────────────────────────────────────────────────────
  // The bar sits inside the border so it spans innerWidth chars.
  const barChar = '━';
  const barStr = barChar.repeat(innerWidth);

  // ── Bottom meta line (labels left, owner right) ───────────────────────────
  // We need to right-align owner within textWidth.
  // Labels get remaining space; if labels + owner exceed width, truncate labels.
  const ownerStr = owner ? owner : '';
  // padding between labels and owner: at least 1 space
  const metaAvailForLabels = ownerStr
    ? Math.max(0, textWidth - ownerStr.length - 1)
    : textWidth;
  const labelsTruncated = labelsStr.length > metaAvailForLabels
    ? truncate(labelsStr, metaAvailForLabels)
    : labelsStr;
  // Fill gap with spaces so owner ends up right-aligned
  const gapLen = textWidth - labelsTruncated.length - ownerStr.length;
  const gap = ' '.repeat(Math.max(1, gapLen));

  return h(Box, {
    flexDirection: 'column',
    width: totalWidth,
    borderStyle: 'single',
    borderColor,
  },
    // ── Line 1: indicator + title ─────────────────────────────────────────
    h(Box, { flexDirection: 'row' },
      h(Text, null, ' '),
      h(Text, { color: indicatorColor, dimColor: indicatorDim, bold: true }, indicator),
      h(Text, null, ' '),
      h(Text, {
        color: isSelected ? 'cyan' : 'white',
        bold: true,
      }, titleText),
    ),

    // ── Lines 2-6: description (only if present) ──────────────────────────
    ...descLines.map((line, i) =>
      h(Text, { key: `desc-${i}`, dimColor: true }, ' ', line)
    ),

    // ── Meta line: [labels] ... owner ────────────────────────────────────
    h(Box, { flexDirection: 'row' },
      h(Text, null, ' '),
      h(Text, { color: 'magenta', dimColor: !labelsTruncated }, labelsTruncated),
      h(Text, null, gap),
      h(Text, { color: 'cyan' }, ownerStr),
    ),

    // ── Status bar ────────────────────────────────────────────────────────
    h(Text, { color: barColor }, barStr),
  );
}
