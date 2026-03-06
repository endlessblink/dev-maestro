import React from 'react';
import { Box, Text } from 'ink';
import { getTypeIcon, getPriorityLabel } from '../lib/colors.js';

const h = React.createElement;

function Field({ label, value, color }) {
  return h(Box, { gap: 1 },
    h(Text, { dimColor: true }, `${label}:`),
    h(Text, { color }, String(value || '-')),
  );
}

export default function DetailPanel({ issue, width }) {
  if (!issue) return null;

  const icon = getTypeIcon(issue.issue_type);
  const pLabel = getPriorityLabel(issue.priority);
  const created = issue.created_at ? new Date(issue.created_at).toLocaleDateString() : '-';
  const updated = issue.updated_at ? new Date(issue.updated_at).toLocaleDateString() : '-';

  return h(Box, {
    flexDirection: 'column',
    width,
    borderStyle: 'round',
    borderColor: 'cyan',
    paddingX: 1,
    paddingY: 0,
  },
    // Title
    h(Text, { bold: true, color: 'cyan', wrap: 'wrap' }, `${icon} ${issue.title}`),
    h(Text, null, ''),

    // Metadata
    h(Field, { label: 'ID', value: issue.id }),
    h(Field, { label: 'Status', value: issue.status, color: 'yellow' }),
    h(Field, { label: 'Priority', value: pLabel, color: issue.priority <= 1 ? 'red' : undefined }),
    h(Field, { label: 'Type', value: issue.issue_type }),
    issue.external_ref ? h(Field, { label: 'Ref', value: issue.external_ref }) : null,
    issue.owner ? h(Field, { label: 'Owner', value: issue.owner }) : null,
    h(Field, { label: 'Created', value: created }),
    h(Field, { label: 'Updated', value: updated }),

    // Labels
    issue.labels?.length > 0
      ? h(Box, { gap: 1 },
          h(Text, { dimColor: true }, 'Labels:'),
          ...issue.labels.map(l => h(Text, { key: l, color: 'magenta' }, l)),
        )
      : null,

    // Description
    issue.description ? h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { dimColor: true, underline: true }, 'Description:'),
      h(Text, { wrap: 'wrap' }, issue.description),
    ) : null,

    // Dependencies
    issue.blocked_by?.length > 0
      ? h(Box, { flexDirection: 'column', marginTop: 1 },
          h(Text, { dimColor: true, underline: true }, 'Blocked by:'),
          ...issue.blocked_by.map(id => h(Text, { key: id, color: 'red' }, `  \u{2022} ${id}`)),
        )
      : null,

    // Close reason
    issue.close_reason
      ? h(Box, { marginTop: 1 },
          h(Text, { dimColor: true }, 'Reason: '),
          h(Text, { color: 'green' }, issue.close_reason),
        )
      : null,
  );
}
