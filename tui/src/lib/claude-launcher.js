import { execSync, spawn } from 'node:child_process';

/**
 * Build the claude command string for a given issue.
 * @param {Object} issue - beads issue object
 * @returns {string} - full claude command string
 */
export function buildClaudeCommand(issue) {
  const ref = issue.external_ref || issue.title;
  const prompt = `Work on ${ref}. Check docs/MASTER_PLAN.md for context, then begin implementation.`;
  // Escape single quotes in prompt for shell
  const escaped = prompt.replace(/'/g, "'\\''");
  return `claude '${escaped}'`;
}

/**
 * Build a research-only claude command for a given issue.
 * @param {Object} issue - beads issue object
 * @returns {string} - full claude command string (research mode, no code changes)
 */
export function buildResearchCommand(issue) {
  const ref = issue.external_ref || issue.title;
  const prompt = `Research ${ref}. Read code and docs, understand the problem, report findings. Do NOT make any code changes.`;
  const escaped = prompt.replace(/'/g, "'\\''");
  return `claude '${escaped}'`;
}

/**
 * Copy text to system clipboard.
 * Uses xclip on Linux, pbcopy on macOS.
 * @param {string} text
 * @returns {boolean} success
 */
export function copyToClipboard(text) {
  try {
    // Use spawn (non-blocking) — xclip forks to serve the X selection and never exits,
    // which causes execSync to hang indefinitely.
    const child = spawn('xclip', ['-selection', 'clipboard'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.write(text);
    child.stdin.end();
    child.unref();  // Don't block Node exit
    return true;
  } catch {
    try {
      const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.write(text);
      child.stdin.end();
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Detect if running inside tmux and send command to a pane.
 * @param {string} command - the command to send
 * @returns {boolean} success
 */
export function tmuxSendKeys(command) {
  if (!process.env.TMUX) return false;
  try {
    // Find a pane that might be running a shell (not the TUI)
    const panes = execSync('tmux list-panes -F "#{pane_id} #{pane_current_command}"', {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim().split('\n');

    // Find a shell pane (bash, zsh, fish) that's not the current one
    const currentPane = execSync('tmux display-message -p "#{pane_id}"', {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const shellPane = panes.find(p => {
      const [id, cmd] = p.split(' ');
      return id !== currentPane && ['bash', 'zsh', 'fish', 'sh'].includes(cmd);
    });

    if (!shellPane) return false;
    const targetPane = shellPane.split(' ')[0];

    execSync(`tmux send-keys -t ${targetPane} -l ${JSON.stringify(command)}`, { stdio: 'pipe' });
    execSync(`tmux send-keys -t ${targetPane} C-m`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the launch strategy.
 * @returns {'tmux' | 'clipboard' | 'spawn'}
 */
export function detectStrategy() {
  if (process.env.TMUX) return 'tmux';
  return 'clipboard';
}
