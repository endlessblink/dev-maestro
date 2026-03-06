#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { spawn } from 'node:child_process';
import App from './app.js';

const instance = render(React.createElement(App));

instance.waitUntilExit().then(() => {
  const cmd = process.env.CLAUDE_TUI_LAUNCH;
  if (cmd) {
    // Spawn claude interactively — it takes over the terminal
    const child = spawn(cmd, { stdio: 'inherit', shell: true });
    child.on('exit', (code) => process.exit(code || 0));
  }
});
