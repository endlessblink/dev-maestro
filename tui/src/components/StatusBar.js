import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

const HINTS = {
  board: '[o] new  [/] search  [Enter] open  [R] research  [c] claude  [s] sort  [v] view  [q] quit',
  detail: '[h] close  [m] forward  [M] backward  [Enter] claude  [R] research',
  help: '[Esc] close',
  search: '[Enter] select  [Esc] close',
  create: '[Enter] submit  [Esc] cancel',
};

export default function StatusBar({ message, mode, selectedIssue }) {
  const hints = HINTS[mode] || HINTS.board;

  return h(Box, {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingX: 1,
    borderStyle: 'single',
    borderColor: 'gray',
  },
    // Left: hints
    h(Text, { dimColor: true }, hints),
    // Right: message or selected task id
    message
      ? h(Text, { color: 'yellow' }, message)
      : selectedIssue
        ? h(Text, { dimColor: true }, `[${selectedIssue.id}]`)
        : null,
  );
}
