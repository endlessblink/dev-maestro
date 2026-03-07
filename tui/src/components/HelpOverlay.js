import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

const KEYBINDINGS = [
  ['Navigation', [
    ['j / \u2193', 'Next task (down row in card view)'],
    ['k / \u2191', 'Previous task (up row in card view)'],
    ['l / \u2192', 'Right in card grid / open detail'],
    ['h / \u2190', 'Left in card grid / close detail'],
    ['g', 'Jump to first task'],
    ['G', 'Jump to last task'],
  ]],
  ['Filters', [
    ['Tab', 'Next filter tab'],
    ['Shift+Tab', 'Previous filter tab'],
    ['1-6', 'Jump to filter (1=All 2=Ready 3=WIP 4=Review 5=Backlog 6=Done)'],
  ]],
  ['Actions', [
    ['Enter / l', 'Toggle detail panel'],
    ['h / Esc', 'Close detail panel'],
    ['s', 'Cycle sort (priority → date → type)'],
    ['m', 'Move task forward in pipeline'],
    ['M', 'Move task backward in pipeline'],
    ['x', 'Close task'],
    ['o', 'Create new task'],
    ['S', 'Setup wizard (new project)'],
    ['r', 'Refresh data'],
  ]],
  ['Claude', [
    ['c', 'Copy claude command to clipboard'],
    ['C', 'Exit TUI + launch Claude on task'],
    ['R', 'Exit TUI + launch Claude in research mode'],
  ]],
  ['Views', [
    ['v', 'Toggle compact/card view'],
    ['/', 'Search tasks'],
    ['?', 'Show this help'],
    ['q', 'Quit (or close panel)'],
    ['Esc', 'Close overlay/panel'],
  ]],
];

export default function HelpOverlay({ onClose }) {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'double',
    borderColor: 'cyan',
    paddingX: 2,
    paddingY: 1,
    position: 'absolute',
    marginLeft: 10,
    marginTop: 3,
  },
    h(Text, { bold: true, color: 'cyan' }, '\u{2328}\u{FE0F}  Keyboard Shortcuts'),
    h(Text, null, ''),
    ...KEYBINDINGS.flatMap(([section, keys]) => [
      h(Text, { key: `s-${section}`, bold: true, underline: true }, section),
      ...keys.map(([key, desc]) =>
        h(Box, { key: `k-${key}`, gap: 2 },
          h(Text, { color: 'yellow' }, key.padEnd(12)),
          h(Text, null, desc),
        )
      ),
      h(Text, { key: `sp-${section}` }, ''),
    ]),
    h(Text, { dimColor: true }, 'Press Esc or ? to close'),
  );
}
