import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

/**
 * Horizontal filter tab bar.
 *
 * Props:
 *   filters      - array of { key, label, color, count }
 *   activeFilter - key string of currently active filter
 *   stats        - optional stats object (unused here; counts come via filter.count)
 *
 * Renders:
 *   [ALL 265] [READY 83] [WIP 9] [REVIEW 4] [BACKLOG 120] [DONE 49]   / search  ? help  q quit
 */
export default function FilterBar({ filters, activeFilter, stats }) {
  const tabs = (filters || []).map(filter => {
    const isActive = filter.key === activeFilter;
    const count = filter.count != null ? filter.count : '';
    const label = count !== '' ? `${filter.label} ${count}` : filter.label;
    const displayColor = filter.color || 'white';

    return h(Box, { key: filter.key, marginRight: 1 },
      h(Text, {
        bold: isActive,
        color: isActive ? displayColor : undefined,
        inverse: isActive,
        dimColor: !isActive,
      },
        `[${label}]`
      )
    );
  });

  const hints = h(Text, { dimColor: true, key: 'hints' },
    '/ search  ? help  q quit'
  );

  return h(Box, {
    flexDirection: 'row',
    paddingX: 1,
    alignItems: 'center',
  },
    ...tabs,
    // Spacer-like gap before hints
    h(Box, { flexGrow: 1, key: 'spacer' }),
    hints,
  );
}
