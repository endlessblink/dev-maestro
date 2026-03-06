import { useState, useEffect, useCallback } from 'react';
import { bd } from '../lib/bd-client.js';
import { bucketIssues } from '../lib/columns.js';
import { parseMasterPlanDescriptions, getMasterPlanPath } from '../lib/masterplan-parser.js';

export function useBoardData() {
  const [allIssues, setAllIssues] = useState([]);
  const [readyIds, setReadyIds] = useState(new Set());
  const [blockedIds, setBlockedIds] = useState(new Set());
  const [columns, setColumns] = useState({
    backlog: [], ready: [], in_progress: [], review: [], done: [],
  });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(() => {
    try {
      // Fetch all data sources
      const issues = bd('list --limit 0') || [];
      const readyIssues = bd('ready') || [];
      const blockedIssues = bd('blocked') || [];
      const closedIssues = bd('list --limit 0 --status=closed') || [];
      const statsData = bd('stats');

      // Build ID sets
      const rIds = new Set(readyIssues.map(i => i.id));
      const bIds = new Set(blockedIssues.map(i => i.id));

      // Merge closed into all issues if not already there
      const allIds = new Set(issues.map(i => i.id));
      for (const ci of closedIssues) {
        if (!allIds.has(ci.id)) issues.push(ci);
      }

      // Sort by priority (lower = higher priority) for non-closed
      issues.sort((a, b) => {
        if (a.status === 'closed' && b.status !== 'closed') return 1;
        if (a.status !== 'closed' && b.status === 'closed') return -1;
        return (a.priority ?? 4) - (b.priority ?? 4);
      });

      // Enrich issues with descriptions from MASTER_PLAN.md
      const masterPlanPath = getMasterPlanPath();
      const descriptions = parseMasterPlanDescriptions(masterPlanPath);
      const enrichedIssues = issues.map(issue => {
        const ref = issue.external_ref;
        if (ref && descriptions.has(ref)) {
          return { ...issue, description: descriptions.get(ref) };
        }
        return issue;
      });

      setAllIssues(enrichedIssues);
      setReadyIds(rIds);
      setBlockedIds(bIds);
      // Keep backward-compat bucketed columns for SearchOverlay
      setColumns(bucketIssues(enrichedIssues, rIds, bIds));
      setStats(statsData?.summary || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { allIssues, readyIds, blockedIds, columns, stats, loading, error, refresh: fetchData };
}
