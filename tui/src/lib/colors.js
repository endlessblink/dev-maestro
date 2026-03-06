import chalk from 'chalk';

export const colors = {
  backlog: chalk.gray,
  ready: chalk.cyan,
  in_progress: chalk.yellow,
  review: chalk.magenta,
  done: chalk.green,
  selected: chalk.bgCyan.black,
  header: chalk.bold.white,
  muted: chalk.dim,
  error: chalk.red,
  success: chalk.green,
  warning: chalk.yellow,
  brand: chalk.hex('#4ECDC4'),  // teal
  priorityCritical: chalk.red.bold,
  priorityHigh: chalk.yellow,
  priorityMedium: chalk.white,
  priorityLow: chalk.dim,
  priorityBacklog: chalk.dim.italic,
  bug: chalk.red,
  feature: chalk.green,
  task: chalk.blue,
  epic: chalk.magenta,
};

/**
 * Returns the chalk function for a given priority (0=critical, 1=high, 2=medium, 3=low, 4=backlog).
 * @param {number|string} p - priority value
 * @returns {Function}
 */
export function getPriorityColor(p) {
  const n = typeof p === 'string' ? parseInt(p, 10) : p;
  switch (n) {
    case 0: return colors.priorityCritical;
    case 1: return colors.priorityHigh;
    case 2: return colors.priorityMedium;
    case 3: return colors.priorityLow;
    case 4: return colors.priorityBacklog;
    default: return colors.priorityMedium;
  }
}

/**
 * Returns the chalk function for a given issue type.
 * @param {string} t - issue type (bug/feature/task/epic)
 * @returns {Function}
 */
export function getTypeColor(t) {
  const type = (t || '').toLowerCase();
  switch (type) {
    case 'bug': return colors.bug;
    case 'feature': return colors.feature;
    case 'task': return colors.task;
    case 'epic': return colors.epic;
    default: return chalk.white;
  }
}

/**
 * Returns an emoji icon for a given issue type.
 * @param {string} t - issue type
 * @returns {string}
 */
export function getTypeIcon(t) {
  const type = (t || '').toLowerCase();
  switch (type) {
    case 'bug': return '🐛';
    case 'feature': return '✨';
    case 'task': return '📋';
    case 'epic': return '🏔️';
    default: return '📋';
  }
}

/** Priority label string */
export function getPriorityLabel(p) {
  switch (p) {
    case 0: return 'P0';
    case 1: return 'P1';
    case 2: return 'P2';
    case 3: return 'P3';
    case 4: return 'P4';
    default: return '??';
  }
}
