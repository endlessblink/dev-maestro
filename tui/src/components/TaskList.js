import React from 'react';
import { Box, Text } from 'ink';
import TaskRow from './TaskRow.js';
import TaskCard from './TaskCard.js';

const h = React.createElement;

/**
 * Scrollable task list with virtual windowing.
 * In card view: renders cards in a multi-column grid (like agtx/kanban-tui).
 * In compact view: renders single-line rows.
 *
 * Props:
 *   issues        - array of issue objects
 *   selectedIndex - currently highlighted row index (0-based)
 *   width         - total available width
 *   height        - available rows for task display (excludes scroll indicators)
 *   blockedIds    - Set of blocked issue IDs (for 🔒 indicator)
 *   viewMode      - 'compact' | 'card'
 */
export default function TaskList({ issues, selectedIndex, width, height, blockedIds, viewMode }) {
  const totalWidth = width || 80;
  const totalHeight = height || 20;
  const count = issues ? issues.length : 0;

  // Card view: multi-column grid
  if (viewMode === 'card') {
    // Card width: ~50-60 chars for readability (like agtx)
    const cardWidth = Math.min(60, Math.max(40, Math.floor(totalWidth / 2) - 1));
    const cols = Math.max(1, Math.floor(totalWidth / (cardWidth + 1)));
    const cardHeight = 8; // approximate lines per card (title + desc + meta + bar + borders)

    // How many rows of cards fit
    const cardRowsVisible = Math.max(1, Math.floor((totalHeight - 2) / cardHeight));
    const cardsPerPage = cols * cardRowsVisible;

    // Windowing: keep selected card visible
    let startIdx = 0;
    if (count > cardsPerPage && selectedIndex >= 0) {
      const selectedRow = Math.floor(selectedIndex / cols);
      const halfRows = Math.floor(cardRowsVisible / 2);
      const startRow = Math.max(0, Math.min(selectedRow - halfRows, Math.ceil(count / cols) - cardRowsVisible));
      startIdx = startRow * cols;
    }
    const endIdx = Math.min(count, startIdx + cardsPerPage);

    const hasAbove = startIdx > 0;
    const hasBelow = endIdx < count;

    const visibleIssues = (issues || []).slice(startIdx, endIdx);

    if (count === 0) {
      return h(Box, { flexDirection: 'column', width: totalWidth, height: totalHeight },
        h(Text, { dimColor: true }, '  (No tasks in this filter)'),
      );
    }

    const children = [];

    if (hasAbove) {
      children.push(
        h(Text, { key: 'scroll-top', dimColor: true }, `  \u25B2 ${startIdx} more`)
      );
    }

    // Arrange cards into rows of `cols` cards each
    const rows = [];
    for (let i = 0; i < visibleIssues.length; i += cols) {
      rows.push(visibleIssues.slice(i, i + cols));
    }

    rows.forEach((rowIssues, rowIdx) => {
      children.push(
        h(Box, { key: `row-${rowIdx}`, flexDirection: 'row', gap: 1 },
          ...rowIssues.map((issue, colIdx) => {
            const absIdx = startIdx + (rowIdx * cols) + colIdx;
            return h(TaskCard, {
              key: issue.id ?? absIdx,
              issue,
              isSelected: absIdx === selectedIndex,
              isBlocked: blockedIds ? blockedIds.has(issue.id) : false,
              width: cardWidth,
            });
          })
        )
      );
    });

    if (hasBelow) {
      children.push(
        h(Text, { key: 'scroll-bottom', dimColor: true }, `  \u25BC ${count - endIdx} more`)
      );
    }

    return h(Box, { flexDirection: 'column', width: totalWidth, height: totalHeight }, ...children);
  }

  // Compact view: single-line rows (original behavior)
  const reservedRows = 2;
  const visibleRows = Math.max(1, totalHeight - reservedRows);

  let startIdx = 0;
  if (count > visibleRows && selectedIndex >= 0) {
    const half = Math.floor(visibleRows / 2);
    startIdx = Math.max(0, Math.min(selectedIndex - half, count - visibleRows));
  }
  const endIdx = Math.min(count, startIdx + visibleRows);

  const hasAbove = startIdx > 0;
  const hasBelow = endIdx < count;

  const visibleIssues = (issues || []).slice(startIdx, endIdx);

  if (count === 0) {
    return h(Box, { flexDirection: 'column', width: totalWidth, height: totalHeight },
      h(Text, { dimColor: true }, '  (No tasks in this filter)'),
    );
  }

  const children = [];

  if (hasAbove) {
    children.push(
      h(Text, { key: 'scroll-top', dimColor: true }, `  \u25B2 ${startIdx} more`)
    );
  }

  visibleIssues.forEach((issue, relIdx) => {
    const absIdx = startIdx + relIdx;
    children.push(
      h(TaskRow, {
        key: issue.id ?? absIdx,
        issue,
        isSelected: absIdx === selectedIndex,
        isBlocked: blockedIds ? blockedIds.has(issue.id) : false,
        width: totalWidth,
      })
    );
  });

  if (hasBelow) {
    children.push(
      h(Text, { key: 'scroll-bottom', dimColor: true }, `  \u25BC ${count - endIdx} more`)
    );
  }

  return h(Box, { flexDirection: 'column', width: totalWidth, height: totalHeight }, ...children);
}
