import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { getTypeIcon, getPriorityLabel } from '../lib/colors.js';
import { truncate } from '../lib/truncate.js';

const h = React.createElement;

export default function SearchOverlay({ columns, onSelect, onClose }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  // Flatten all issues from all columns
  const allIssues = useMemo(() => {
    const issues = [];
    for (const key of Object.keys(columns)) {
      for (const issue of columns[key]) {
        issues.push({ ...issue, _column: key });
      }
    }
    return issues;
  }, [columns]);

  // Filter by query
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return allIssues.filter(i =>
      i.title?.toLowerCase().includes(q) ||
      i.id?.toLowerCase().includes(q) ||
      i.external_ref?.toLowerCase().includes(q) ||
      i.description?.toLowerCase().includes(q)
    ).slice(0, 15);
  }, [query, allIssues]);

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.return && results.length > 0) {
      onSelect(results[Math.min(cursor, results.length - 1)]);
      return;
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      setCursor(c => Math.min(results.length - 1, c + 1));
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }
  });

  // Reset cursor when query changes
  const handleChange = (val) => {
    setQuery(val);
    setCursor(0);
  };

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'double',
    borderColor: 'yellow',
    paddingX: 2,
    paddingY: 1,
    position: 'absolute',
    marginLeft: 10,
    marginTop: 3,
    width: 60,
  },
    h(Text, { bold: true, color: 'yellow' }, '\u{1F50D} Search Tasks'),
    h(Box, { marginY: 1 },
      h(Text, null, '> '),
      h(TextInput, { value: query, onChange: handleChange, focus: true }),
    ),
    results.length > 0
      ? h(Box, { flexDirection: 'column' },
          ...results.map((issue, idx) =>
            h(Box, {
              key: issue.id,
              gap: 1,
            },
              h(Text, { color: idx === cursor ? 'cyan' : undefined },
                idx === cursor ? '\u{25B6}' : ' '
              ),
              h(Text, null, getTypeIcon(issue.issue_type)),
              h(Text, { color: idx === cursor ? 'cyan' : undefined },
                truncate(issue.title, 40)
              ),
              h(Text, { dimColor: true }, `[${issue._column}]`),
            )
          ),
        )
      : query.trim()
        ? h(Text, { dimColor: true }, 'No results')
        : h(Text, { dimColor: true }, 'Type to search...'),
    h(Text, { dimColor: true, marginTop: 1 }, '\u2191\u2193:navigate  Enter:select  Esc:close'),
  );
}
