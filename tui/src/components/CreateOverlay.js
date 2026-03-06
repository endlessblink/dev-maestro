import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { bdExec } from '../lib/bd-client.js';

const h = React.createElement;

const TYPES = ['task', 'bug', 'feature', 'epic'];
const PRIORITIES = [
  { value: 0, label: 'P0 - Critical' },
  { value: 1, label: 'P1 - High' },
  { value: 2, label: 'P2 - Medium' },
  { value: 3, label: 'P3 - Low' },
  { value: 4, label: 'P4 - Backlog' },
];

export default function CreateOverlay({ onCreated, onClose }) {
  const [step, setStep] = useState(0); // 0=title, 1=type, 2=priority, 3=confirm
  const [title, setTitle] = useState('');
  const [typeIdx, setTypeIdx] = useState(0);
  const [prioIdx, setPrioIdx] = useState(2);
  const [error, setError] = useState('');

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }

    // Type selection (step 1)
    if (step === 1) {
      if (key.upArrow || input === 'k') { setTypeIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === 'j') { setTypeIdx(i => Math.min(TYPES.length - 1, i + 1)); return; }
      if (key.return) { setStep(2); return; }
    }

    // Priority selection (step 2)
    if (step === 2) {
      if (key.upArrow || input === 'k') { setPrioIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow || input === 'j') { setPrioIdx(i => Math.min(PRIORITIES.length - 1, i + 1)); return; }
      if (key.return) { setStep(3); return; }
    }

    // Confirm (step 3)
    if (step === 3) {
      if (input === 'y' || key.return) {
        const type = TYPES[typeIdx];
        const prio = PRIORITIES[prioIdx].value;
        const escaped = title.replace(/"/g, '\\"');
        const res = bdExec(`create --title="${escaped}" --type=${type} --priority=${prio}`);
        if (res.success) {
          onCreated();
        } else {
          setError(res.output);
        }
        return;
      }
      if (input === 'n') { onClose(); return; }
    }
  });

  const handleTitleSubmit = (val) => {
    if (val.trim()) {
      setTitle(val);
      setStep(1);
    }
  };

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'double',
    borderColor: 'green',
    paddingX: 2,
    paddingY: 1,
    position: 'absolute',
    marginLeft: 15,
    marginTop: 5,
    width: 50,
  },
    h(Text, { bold: true, color: 'green' }, '\u{2795} Create New Task'),
    h(Text, null, ''),

    // Step 0: Title
    step === 0 ? h(Box, { flexDirection: 'column' },
      h(Text, null, 'Title:'),
      h(Box, null,
        h(Text, null, '> '),
        h(TextInput, { value: title, onChange: setTitle, onSubmit: handleTitleSubmit, focus: true }),
      ),
      h(Text, { dimColor: true }, 'Enter to continue, Esc to cancel'),
    ) : h(Text, { dimColor: true }, `Title: ${title}`),

    // Step 1: Type
    step >= 1 ? h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { bold: step === 1 }, 'Type:'),
      ...TYPES.map((t, idx) =>
        h(Text, {
          key: t,
          color: step === 1 && idx === typeIdx ? 'cyan' : undefined,
        }, `${idx === typeIdx && step === 1 ? '\u{25B6} ' : '  '}${t}`)
      ),
    ) : null,

    // Step 2: Priority
    step >= 2 ? h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { bold: step === 2 }, 'Priority:'),
      ...PRIORITIES.map((p, idx) =>
        h(Text, {
          key: String(p.value),
          color: step === 2 && idx === prioIdx ? 'cyan' : undefined,
        }, `${idx === prioIdx && step === 2 ? '\u{25B6} ' : '  '}${p.label}`)
      ),
    ) : null,

    // Step 3: Confirm
    step === 3 ? h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { bold: true }, 'Create this task?'),
      h(Text, null, `  Title: ${title}`),
      h(Text, null, `  Type: ${TYPES[typeIdx]}`),
      h(Text, null, `  Priority: ${PRIORITIES[prioIdx].label}`),
      h(Text, { dimColor: true, marginTop: 1 }, 'y/Enter:create  n/Esc:cancel'),
    ) : null,

    // Error
    error ? h(Text, { color: 'red', marginTop: 1 }, `Error: ${error}`) : null,
  );
}
