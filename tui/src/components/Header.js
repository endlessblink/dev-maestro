import React from 'react';
import { Box, Text, Spacer } from 'ink';

const h = React.createElement;

export default function Header({ stats, termWidth }) {
  const open = stats?.open_issues ?? '?';
  const inProg = stats?.in_progress_issues ?? '?';
  const closed = stats?.closed_issues ?? '?';
  const total = stats?.total_issues ?? '?';
  const blocked = stats?.blocked_issues ?? '?';

  return h(Box, {
    flexDirection: 'row',
    width: termWidth,
    paddingX: 1,
    borderStyle: 'single',
    borderColor: 'gray',
  },
    h(Text, { bold: true, color: 'cyan' }, '\u{1F3AF} Dev-Maestro TUI'),
    h(Spacer),
    h(Text, null, 'Open:'),
    h(Text, { color: 'cyan' }, String(open)),
    h(Text, null, '  WIP:'),
    h(Text, { color: 'yellow' }, String(inProg)),
    h(Text, null, '  Blocked:'),
    h(Text, { color: 'red' }, String(blocked)),
    h(Text, null, '  Done:'),
    h(Text, { color: 'green' }, String(closed)),
    h(Text, { dimColor: true }, `  (${total} total)`),
  );
}
