import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolve, join } from 'path';

const h = React.createElement;

const INSTALL_DIR = process.env.DEV_MAESTRO_DIR || join(process.env.HOME, '.dev-maestro');

const MODULES = [
  { key: 'dashboard', label: 'Dashboard (web UI on :6010)', defaultOn: true },
  { key: 'skills',    label: 'Claude Skills (/next /done /save)', defaultOn: true },
  { key: 'tui',       label: 'TUI (terminal board)', defaultOn: false },
  { key: 'beads',     label: 'Beads (dependency tracking)', defaultOn: false },
  { key: 'health',    label: 'Health Scanner', defaultOn: false },
];

const PLAN_LOCATIONS = [
  'MASTER_PLAN.md',
  'docs/MASTER_PLAN.md',
  'planning/MASTER_PLAN.md',
  '.github/MASTER_PLAN.md',
  'doc/MASTER_PLAN.md',
];

function detectMasterPlan(projectPath) {
  for (const loc of PLAN_LOCATIONS) {
    const full = join(projectPath, loc);
    if (existsSync(full)) return loc;
  }
  return null;
}

export default function SetupWizard({ projectPath: initialPath, onDone, onCancel }) {
  const { exit } = useApp();

  // Steps: 0=project path, 1=module selection, 2=installing, 3=done
  const [step, setStep] = useState(initialPath ? 1 : 0);
  const [projectPath, setProjectPath] = useState(initialPath || process.cwd());
  const [pathInput, setPathInput] = useState(initialPath || process.cwd());
  const [planRelPath, setPlanRelPath] = useState(null);
  const [checked, setChecked] = useState(() =>
    MODULES.map(m => m.defaultOn)
  );
  const [cursor, setCursor] = useState(0);
  const [installOutput, setInstallOutput] = useState([]);
  const [installDone, setInstallDone] = useState(false);
  const [installError, setInstallError] = useState(false);

  // Detect MASTER_PLAN.md when project path changes
  useEffect(() => {
    if (projectPath && existsSync(projectPath)) {
      const found = detectMasterPlan(projectPath);
      setPlanRelPath(found);
    } else {
      setPlanRelPath(null);
    }
  }, [projectPath]);

  // Auto-detect on initial path
  useEffect(() => {
    if (initialPath) {
      setProjectPath(initialPath);
    }
  }, [initialPath]);

  const selectedModules = MODULES.filter((_, i) => checked[i]).map(m => m.key);

  const runInstall = useCallback(() => {
    setStep(2);
    setInstallOutput(['Starting installation...']);

    const modulesArg = selectedModules.join(',');
    const scriptPath = join(INSTALL_DIR, 'install.sh');
    const args = [scriptPath, projectPath, `--modules=${modulesArg}`, '--non-interactive'];

    const child = spawn('bash', args, {
      cwd: INSTALL_DIR,
      env: { ...process.env, DEV_MAESTRO_DIR: INSTALL_DIR },
    });

    child.stdout.on('data', (data) => {
      const lines = data.toString().replace(/\033\[[0-9;]*m/g, '').split('\n').filter(Boolean);
      setInstallOutput(prev => [...prev.slice(-20), ...lines]);
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().replace(/\033\[[0-9;]*m/g, '').split('\n').filter(Boolean);
      setInstallOutput(prev => [...prev.slice(-20), ...lines]);
    });

    child.on('close', (code) => {
      if (code === 0) {
        setInstallOutput(prev => [...prev, '', 'Installation complete!']);
        setInstallDone(true);
      } else {
        setInstallOutput(prev => [...prev, '', `Installation failed (exit code ${code})`]);
        setInstallError(true);
        setInstallDone(true);
      }
      setStep(3);
    });

    child.on('error', (err) => {
      setInstallOutput(prev => [...prev, `Error: ${err.message}`]);
      setInstallError(true);
      setInstallDone(true);
      setStep(3);
    });
  }, [projectPath, selectedModules]);

  // Handle path submission
  const handlePathSubmit = useCallback((val) => {
    const resolved = resolve(val.replace(/^~/, process.env.HOME));
    if (existsSync(resolved)) {
      setProjectPath(resolved);
      setStep(1);
    } else {
      setProjectPath(val);
      // Still allow proceeding — install.sh will create MASTER_PLAN.md
      setStep(1);
    }
  }, []);

  // Input handler
  useInput((input, key) => {
    if (key.escape || (input === 'q' && step !== 0)) {
      if (step === 3) {
        onDone ? onDone() : onCancel ? onCancel() : null;
        return;
      }
      onCancel ? onCancel() : null;
      return;
    }

    // Module selection (step 1)
    if (step === 1) {
      if (key.upArrow || input === 'k') {
        setCursor(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor(i => Math.min(MODULES.length - 1, i + 1));
        return;
      }
      if (input === ' ') {
        setChecked(prev => {
          const next = [...prev];
          next[cursor] = !next[cursor];
          return next;
        });
        return;
      }
      if (key.return) {
        runInstall();
        return;
      }
    }

    // Done screen (step 3)
    if (step === 3 && (key.return || input === 'q')) {
      onDone ? onDone() : onCancel ? onCancel() : null;
      return;
    }
  }, { isActive: step !== 0 });

  // Title bar
  const titleBar = h(Box, { flexDirection: 'row', marginBottom: 1 },
    h(Text, { bold: true, color: 'cyan' }, 'Dev Maestro -- Project Setup'),
  );

  // Step 0: Path input
  if (step === 0) {
    return h(Box, {
      flexDirection: 'column',
      borderStyle: 'double',
      borderColor: 'cyan',
      paddingX: 2,
      paddingY: 1,
      position: 'absolute',
      marginLeft: 10,
      marginTop: 3,
      width: 60,
    },
      titleBar,
      h(Text, null, 'Project path:'),
      h(Box, null,
        h(Text, null, '> '),
        h(TextInput, {
          value: pathInput,
          onChange: setPathInput,
          onSubmit: handlePathSubmit,
          focus: true,
        }),
      ),
      h(Text, { dimColor: true, marginTop: 1 }, 'Enter to continue, Esc to cancel'),
    );
  }

  // Step 1: Module selection
  if (step === 1) {
    const pathExists = existsSync(projectPath);
    return h(Box, {
      flexDirection: 'column',
      borderStyle: 'double',
      borderColor: 'cyan',
      paddingX: 2,
      paddingY: 1,
      position: 'absolute',
      marginLeft: 10,
      marginTop: 3,
      width: 60,
    },
      titleBar,
      h(Box, { flexDirection: 'row' },
        h(Text, null, 'Project: '),
        h(Text, { color: pathExists ? 'green' : 'yellow' }, projectPath),
      ),
      h(Box, { flexDirection: 'row' },
        h(Text, null, 'MASTER_PLAN: '),
        planRelPath
          ? h(Text, { color: 'green' }, `${planRelPath}  `, h(Text, { color: 'green' }, 'OK'))
          : h(Text, { color: 'yellow' }, 'not found (will be created)'),
      ),
      h(Text, null, ''),
      h(Text, { bold: true }, 'Select modules to install:'),
      h(Text, { dimColor: true }, '(space=toggle  j/k=navigate  Enter=install)'),
      h(Text, null, ''),
      ...MODULES.map((mod, idx) =>
        h(Box, { key: mod.key, flexDirection: 'row' },
          h(Text, {
            color: idx === cursor ? 'cyan' : undefined,
            bold: idx === cursor,
          },
            `${idx === cursor ? '> ' : '  '}[${checked[idx] ? 'x' : ' '}] ${mod.label}`
          ),
        )
      ),
      h(Text, null, ''),
      h(Box, { flexDirection: 'row', gap: 2 },
        h(Text, { color: 'green', bold: true }, '[Enter] Install'),
        h(Text, null, '  '),
        h(Text, { dimColor: true }, '[Esc] Cancel'),
      ),
    );
  }

  // Step 2: Installing
  if (step === 2) {
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
      h(Text, { bold: true, color: 'yellow' }, 'Installing...'),
      h(Text, null, ''),
      ...installOutput.slice(-15).map((line, idx) =>
        h(Text, { key: `out-${idx}`, dimColor: true }, line)
      ),
    );
  }

  // Step 3: Done
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'double',
    borderColor: installError ? 'red' : 'green',
    paddingX: 2,
    paddingY: 1,
    position: 'absolute',
    marginLeft: 10,
    marginTop: 3,
    width: 60,
  },
    h(Text, { bold: true, color: installError ? 'red' : 'green' },
      installError ? 'Installation Failed' : 'Setup Complete!'
    ),
    h(Text, null, ''),
    ...installOutput.slice(-10).map((line, idx) =>
      h(Text, { key: `out-${idx}`, dimColor: true }, line)
    ),
    h(Text, null, ''),
    h(Text, { dimColor: true }, 'Press Enter or q to return'),
  );
}
