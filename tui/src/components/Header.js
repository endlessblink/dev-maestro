import React from 'react';
import { Box, Text, Spacer } from 'ink';

const h = React.createElement;

export default function Header({ stats, termWidth }) {
  // Stats come from /api/tasks/stats as { total, byStatus: [{status, count}] }
  const byStatus = stats?.byStatus || [];
  const getCount = (s) => {
    const entry = byStatus.find(e => e.status === s);
    return entry ? entry.count : 0;
  };

  const total = stats?.total ?? '?';
  const planned = getCount('planned');
  const inProg = getCount('in_progress');
  const review = getCount('review');
  const paused = getCount('paused');
  const closed = getCount('done');
  const open = planned + paused;  // "open" = planned + paused

  return h(Box, {
    flexDirection: 'row',
    width: termWidth,
    paddingX: 1,
    borderStyle: 'single',
    borderColor: 'gray',
  },
    h(Text, { bold: true, color: 'cyan' }, '\u{1F3AF} Dev-Maestro TUI'),
    h(Spacer),
    // Mini progress bar
    (() => {
      if (typeof total !== 'number' || total === 0) return null;
      const barWidth = Math.min(20, Math.floor(termWidth / 8));
      const doneW = Math.round((closed / total) * barWidth);
      const wipW = Math.round((inProg / total) * barWidth);
      const revW = Math.round((review / total) * barWidth);
      const remainW = Math.max(0, barWidth - doneW - wipW - revW);
      const pct = Math.round((closed / total) * 100);
      return h(Box, { flexDirection: 'row', marginRight: 2 },
        h(Text, { color: 'green' }, '\u2588'.repeat(doneW)),
        h(Text, { color: 'yellow' }, '\u2588'.repeat(wipW)),
        h(Text, { color: 'magenta' }, '\u2588'.repeat(revW)),
        h(Text, { color: 'gray' }, '\u2591'.repeat(remainW)),
        h(Text, { dimColor: true }, ` ${pct}%`),
      );
    })(),
    h(Text, null, 'Open:'),
    h(Text, { color: 'cyan' }, String(open)),
    h(Text, null, '  WIP:'),
    h(Text, { color: 'yellow' }, String(inProg)),
    h(Text, null, '  Review:'),
    h(Text, { color: 'magenta' }, String(review)),
    h(Text, null, '  Done:'),
    h(Text, { color: 'green' }, String(closed)),
    h(Text, { dimColor: true }, `  (${total} total)`),
  );
}
