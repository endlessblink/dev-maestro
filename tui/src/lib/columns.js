export const COLUMNS = [
  { key: 'backlog', label: 'Backlog', color: 'gray', statuses: ['open'] },
  { key: 'ready', label: 'Planned', color: 'cyan', statuses: ['open'] },
  { key: 'in_progress', label: 'In Progress', color: 'yellow', statuses: ['in_progress'] },
  { key: 'review', label: 'Review', color: 'magenta', statuses: ['inreview'] },
  { key: 'done', label: 'Done', color: 'green', statuses: ['closed'] },
];

export const PIPELINE = ['open', 'in_progress', 'inreview', 'closed'];

export function statusForColumn(key) {
  const map = {
    backlog: 'open',
    ready: 'open',
    in_progress: 'in_progress',
    review: 'inreview',
    done: 'closed',
  };
  return map[key] || 'open';
}

export function nextStatus(current) {
  const idx = PIPELINE.indexOf(current);
  if (idx < 0 || idx >= PIPELINE.length - 1) return null;
  return PIPELINE[idx + 1];
}

export function prevStatus(current) {
  const idx = PIPELINE.indexOf(current);
  if (idx <= 0) return null;
  return PIPELINE[idx - 1];
}

export function bucketIssues(allIssues, readyIds, blockedIds) {
  const buckets = {
    backlog: [],
    ready: [],
    in_progress: [],
    review: [],
    done: [],
  };

  if (!allIssues) return buckets;

  for (const issue of allIssues) {
    const status = issue.status;
    const hasReviewLabel = issue.labels?.includes('review');

    if (status === 'closed') {
      buckets.done.push(issue);
    } else if (status === 'inreview' || (status === 'open' && hasReviewLabel)) {
      buckets.review.push(issue);
    } else if (status === 'in_progress') {
      buckets.in_progress.push(issue);
    } else if (status === 'open') {
      if (blockedIds.has(issue.id)) {
        buckets.backlog.push(issue);
      } else if (readyIds.has(issue.id)) {
        buckets.ready.push(issue);
      } else {
        buckets.backlog.push(issue);
      }
    } else {
      buckets.backlog.push(issue);
    }
  }

  // Sort done by closed_at descending, limit to 20
  buckets.done.sort((a, b) => {
    const da = a.closed_at || a.updated_at || '';
    const db = b.closed_at || b.updated_at || '';
    return db.localeCompare(da);
  });
  buckets.done = buckets.done.slice(0, 20);

  // Sort other columns by priority (lower = higher priority)
  for (const key of ['backlog', 'ready', 'in_progress', 'review']) {
    buckets[key].sort((a, b) => (a.priority ?? 4) - (b.priority ?? 4));
  }

  return buckets;
}

// Filter definitions for the new master-detail layout
export const FILTERS = [
  { key: 'ready',   label: 'PLANNED', color: 'cyan',    shortcut: '1' },
  { key: 'wip',     label: 'WIP',     color: 'yellow',  shortcut: '2' },
  { key: 'review',  label: 'REVIEW',  color: 'magenta', shortcut: '3' },
  { key: 'backlog', label: 'BACKLOG', color: 'gray',    shortcut: '4' },
  { key: 'done',    label: 'DONE',    color: 'green',   shortcut: '5' },
  { key: 'all',     label: 'ALL',     color: 'white',   shortcut: '6' },
];

/**
 * Apply a filter to the flat issue list.
 * @param {string} filterKey - one of: all, ready, wip, review, backlog, done
 * @param {Array} allIssues - flat array of all issues
 * @param {Set} readyIds - set of ready issue IDs
 * @param {Set} blockedIds - set of blocked issue IDs
 * @returns {Array} filtered issues
 */
export function applyFilter(filterKey, allIssues, readyIds, blockedIds) {
  if (!allIssues) return [];

  switch (filterKey) {
    case 'all':
      // Everything except closed
      return allIssues.filter(i => i.status !== 'closed');
    case 'ready':
      return allIssues.filter(i => i.status === 'open' && readyIds.has(i.id) && !i.labels?.includes('review'));
    case 'wip':
      return allIssues.filter(i => i.status === 'in_progress');
    case 'review':
      return allIssues.filter(i => i.status === 'inreview' || (i.status === 'open' && i.labels?.includes('review')));
    case 'backlog':
      return allIssues.filter(i =>
        i.status === 'open' && !readyIds.has(i.id) && !i.labels?.includes('review')
      );
    case 'done':
      return allIssues
        .filter(i => i.status === 'closed')
        .sort((a, b) => {
          const da = a.closed_at || a.updated_at || '';
          const db = b.closed_at || b.updated_at || '';
          return db.localeCompare(da);
        })
        .slice(0, 20);
    default:
      return allIssues.filter(i => i.status !== 'closed');
  }
}
