import { useState, useEffect, useCallback } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { bdAsync } from '../lib/bd-client.js';
import { bucketIssues } from '../lib/columns.js';
import { parseMasterPlanDescriptions, getMasterPlanPath } from '../lib/masterplan-parser.js';

let _projectActivated = false;

function loadDotEnv() {
  const envPath = path.join(process.env.HOME, '.dev-maestro', '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  return env;
}

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

  const fetchData = useCallback(async () => {
    try {
      // Auto-activate the project matching MAESTRO_CWD (if set)
      const cwd = process.env.MAESTRO_CWD;
      if (cwd && !_projectActivated) {
        _projectActivated = true; // only try once
        try {
          const projFile = path.join(process.env.HOME, '.dev-maestro', 'projects.json');
          if (fs.existsSync(projFile)) {
            const registry = JSON.parse(fs.readFileSync(projFile, 'utf8'));
            const match = (registry.projects || []).find(p => cwd.startsWith(p.root));
            if (match && match.name) {
              const dotEnv = loadDotEnv();
              const port = process.env.PORT || dotEnv.PORT || 6010;
              const serverUrl = process.env.MAESTRO_SERVER_URL || `http://localhost:${port}`;
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 5000);
              try {
                await fetch(`${serverUrl}/api/projects/${encodeURIComponent(match.name)}/activate`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  signal: controller.signal,
                });
              } catch { /* server may not be running */ }
              clearTimeout(timeout);
            }
          }
        } catch { /* ignore auto-activation errors */ }
      }

      // Fetch all data sources (parallel where possible)
      const [issues, readyIssues, blockedIssues, closedIssues, statsData] = await Promise.all([
        bdAsync('list --limit 0').then(r => r || []),
        bdAsync('ready').then(r => r || []),
        bdAsync('blocked').then(r => r || []),
        bdAsync('list --limit 0 --status=closed').then(r => r || []),
        bdAsync('stats'),
      ]);

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
