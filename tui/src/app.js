import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useBoardData } from './hooks/use-board-data.js';
import { FILTERS, applyFilter, nextStatus, prevStatus } from './lib/columns.js';
import { bdExecAsync } from './lib/bd-client.js';
import { buildClaudeCommand, buildResearchCommand, copyToClipboard, tmuxSendKeys, detectStrategy } from './lib/claude-launcher.js';
import Header from './components/Header.js';
import FilterBar from './components/FilterBar.js';
import TaskList from './components/TaskList.js';
import StatusBar from './components/StatusBar.js';
import DetailPanel from './components/DetailPanel.js';
import HelpOverlay from './components/HelpOverlay.js';
import SearchOverlay from './components/SearchOverlay.js';
import CreateOverlay from './components/CreateOverlay.js';
import SetupWizard from './components/SetupWizard.js';

const h = React.createElement;

export default function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 120;
  const termHeight = stdout?.rows || 40;

  const { allIssues, readyIds, blockedIds, columns, stats, loading, error, refresh } = useBoardData();
  const [mode, setMode] = useState('board');          // board | detail | help | search | create | setup
  const [activeFilter, setActiveFilter] = useState('ready');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [message, setMessage] = useState('');
  const [msgTimer, setMsgTimer] = useState(null);
  const [sortMode, setSortMode] = useState('priority'); // priority | date | type
  const [viewMode, setViewMode] = useState('card'); // compact | card

  // Filtered + sorted issues based on active tab
  const filteredIssues = useMemo(() => {
    const filtered = applyFilter(activeFilter, allIssues, readyIds, blockedIds);
    switch (sortMode) {
      case 'date':
        return [...filtered].sort((a, b) => {
          const da = a.updated_at || a.created_at || '';
          const db = b.updated_at || b.created_at || '';
          return db.localeCompare(da);  // newest first
        });
      case 'type':
        return [...filtered].sort((a, b) => {
          const ta = a.issue_type || 'task';
          const tb = b.issue_type || 'task';
          if (ta !== tb) return ta.localeCompare(tb);
          return (a.priority ?? 4) - (b.priority ?? 4);
        });
      case 'priority':
      default:
        return filtered; // already sorted by priority from use-board-data
    }
  }, [activeFilter, allIssues, readyIds, blockedIds, sortMode]);

  // Filter counts for the tab bar
  const filterCounts = useMemo(() => {
    const counts = {};
    for (const f of FILTERS) {
      counts[f.key] = applyFilter(f.key, allIssues, readyIds, blockedIds).length;
    }
    return counts;
  }, [allIssues, readyIds, blockedIds]);

  const filtersWithCounts = useMemo(
    () => FILTERS.map(f => ({ ...f, count: filterCounts[f.key] || 0 })),
    [filterCounts]
  );

  const selectedIssue = filteredIssues[selectedIndex] || null;

  // Clamp selected index when filter changes or data refreshes
  useEffect(() => {
    const maxIdx = Math.max(0, filteredIssues.length - 1);
    if (selectedIndex > maxIdx) setSelectedIndex(maxIdx);
  }, [filteredIssues.length, selectedIndex]);

  const showMsg = useCallback((msg, ms = 3000) => {
    setMessage(msg);
    if (msgTimer) clearTimeout(msgTimer);
    const t = setTimeout(() => setMessage(''), ms);
    setMsgTimer(t);
  }, [msgTimer]);

  // Determine effective status for pipeline moves
  const getEffectiveStatus = useCallback(() => {
    if (!selectedIssue) return null;
    // If in review filter but status is 'open' (label-based review), treat as inreview
    if (activeFilter === 'review' && selectedIssue.status === 'open') return 'inreview';
    return selectedIssue.status;
  }, [selectedIssue, activeFilter]);

  const moveForward = useCallback(async () => {
    if (!selectedIssue) return;
    const effStatus = getEffectiveStatus();
    const next = nextStatus(effStatus);
    if (!next) { showMsg('Already at end of pipeline'); return; }
    let res;
    if (next === 'closed') {
      res = await bdExecAsync(`close ${selectedIssue.id}`);
      showMsg(res.success ? `Closed ${selectedIssue.id}` : `Error: ${res.output}`);
    } else {
      res = await bdExecAsync(`update ${selectedIssue.id} --status ${next}`);
      // Auto-assign when moving to in_progress
      if (next === 'in_progress' && res.success) {
        const user = process.env.USER || process.env.USERNAME || 'me';
        await bdExecAsync(`update ${selectedIssue.id} --assignee ${user}`);
      }
      showMsg(res.success ? `→ ${next}: ${selectedIssue.id}` : `Error: ${res.output}`);
    }
    refresh();
  }, [selectedIssue, getEffectiveStatus, showMsg, refresh]);

  const moveBackward = useCallback(async () => {
    if (!selectedIssue) return;
    const effStatus = getEffectiveStatus();
    const prev = prevStatus(effStatus);
    if (!prev) { showMsg('Already at start of pipeline'); return; }
    const res = await bdExecAsync(`update ${selectedIssue.id} --status ${prev}`);
    showMsg(res.success ? `← ${prev}: ${selectedIssue.id}` : `Error: ${res.output}`);
    refresh();
  }, [selectedIssue, getEffectiveStatus, showMsg, refresh]);

  const closeTask = useCallback(async () => {
    if (!selectedIssue) return;
    const res = await bdExecAsync(`close ${selectedIssue.id}`);
    showMsg(res.success ? `✓ Closed ${selectedIssue.id}` : `Error: ${res.output}`);
    refresh();
  }, [selectedIssue, showMsg, refresh]);

  // Claude integration
  const claudeCopy = useCallback(() => {
    if (!selectedIssue) return;
    const cmd = buildClaudeCommand(selectedIssue);
    const strategy = detectStrategy();
    if (strategy === 'tmux') {
      const sent = tmuxSendKeys(cmd);
      showMsg(sent ? `⚡ Sent to tmux: ${selectedIssue.id}` : '📋 tmux failed — copied to clipboard');
      if (!sent) copyToClipboard(cmd);
    } else {
      const ok = copyToClipboard(cmd);
      showMsg(ok ? `📋 Copied claude command for ${selectedIssue.id}` : '❌ Clipboard failed — install xclip');
    }
  }, [selectedIssue, showMsg]);

  const claudeLaunch = useCallback(() => {
    if (!selectedIssue) return;
    const cmd = buildClaudeCommand(selectedIssue);
    // Set env var synchronously BEFORE exit — React effects won't fire after unmount
    process.env.CLAUDE_TUI_LAUNCH = cmd;
    exit();
  }, [selectedIssue, exit]);

  const researchLaunch = useCallback(() => {
    if (!selectedIssue) return;
    const cmd = buildResearchCommand(selectedIssue);
    process.env.CLAUDE_TUI_LAUNCH = cmd;
    exit();
  }, [selectedIssue, exit]);

  // Filter navigation helpers
  const nextFilter = useCallback(() => {
    const idx = FILTERS.findIndex(f => f.key === activeFilter);
    const nextIdx = (idx + 1) % FILTERS.length;
    setActiveFilter(FILTERS[nextIdx].key);
    setSelectedIndex(0);
  }, [activeFilter]);

  const prevFilter = useCallback(() => {
    const idx = FILTERS.findIndex(f => f.key === activeFilter);
    const prevIdx = (idx - 1 + FILTERS.length) % FILTERS.length;
    setActiveFilter(FILTERS[prevIdx].key);
    setSelectedIndex(0);
  }, [activeFilter]);

  const jumpToFilter = useCallback((num) => {
    const filter = FILTERS[num - 1];
    if (filter) {
      setActiveFilter(filter.key);
      setSelectedIndex(0);
    }
  }, []);

  // Main input handler
  useInput((input, key) => {
    // Quit
    if (input === 'q' && (mode === 'board' || mode === 'detail' || mode === 'help')) {
      if (mode !== 'board') { setMode('board'); setShowDetail(false); return; }
      exit();
      return;
    }

    // Close overlays/panels
    if (key.escape) {
      if (showDetail) { setShowDetail(false); setMode('board'); return; }
      if (mode !== 'board') { setMode('board'); return; }
    }

    // Board mode
    if (mode === 'board' || mode === 'detail') {
      // Grid column count for card view navigation
      const cardWidth = Math.min(60, Math.max(40, Math.floor(listWidth / 2) - 1));
      const gridCols = viewMode === 'card' ? Math.max(1, Math.floor(listWidth / (cardWidth + 1))) : 1;

      // Navigation: up/down move by row, left/right move by 1 in card view
      if (input === 'j' || key.downArrow) {
        setSelectedIndex(i => Math.min(filteredIssues.length - 1, i + gridCols));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setSelectedIndex(i => Math.max(0, i - gridCols));
        return;
      }
      if (key.rightArrow || (input === 'l' && mode !== 'detail')) {
        if (gridCols > 1) {
          setSelectedIndex(i => Math.min(filteredIssues.length - 1, i + 1));
          return;
        }
      }
      if (key.leftArrow || (input === 'h' && mode !== 'detail')) {
        if (gridCols > 1) {
          setSelectedIndex(i => Math.max(0, i - 1));
          return;
        }
      }
      if (input === 'g') { setSelectedIndex(0); return; }
      if (input === 'G') { setSelectedIndex(Math.max(0, filteredIssues.length - 1)); return; }

      // Filter tabs
      if (key.tab && !key.shift) { nextFilter(); return; }
      if (key.tab && key.shift) { prevFilter(); return; }
      // Number keys 1-6 for filter shortcuts
      if ('123456'.includes(input)) { jumpToFilter(parseInt(input, 10)); return; }

      // Detail panel toggle — double Enter launches Claude
      if (key.return || input === 'l') {
        if (mode === 'detail' && key.return) {
          // Already in detail → launch Claude on this task
          claudeLaunch();
          return;
        }
        if (selectedIssue) { setShowDetail(true); setMode('detail'); }
        return;
      }
      if (input === 'h' && mode === 'detail') {
        setShowDetail(false);
        setMode('board');
        return;
      }

      // Sort toggle
      if (input === 's') {
        const modes = ['priority', 'date', 'type'];
        const nextIdx = (modes.indexOf(sortMode) + 1) % modes.length;
        setSortMode(modes[nextIdx]);
        showMsg(`Sort: ${modes[nextIdx]}`);
        return;
      }

      // View mode toggle
      if (input === 'v') {
        setViewMode(m => m === 'compact' ? 'card' : 'compact');
        showMsg(viewMode === 'compact' ? 'View: card' : 'View: compact');
        return;
      }

      // Pipeline actions
      if (input === 'm') { moveForward(); return; }
      if (input === 'M') { moveBackward(); return; }
      if (input === 'x') { closeTask(); return; }
      if (input === 'r') { refresh(); showMsg('Refreshing...'); return; }

      // Claude integration
      if (input === 'c') { claudeCopy(); return; }
      if (input === 'C') { claudeLaunch(); return; }
      if (input === 'R') { researchLaunch(); return; }

      // Mode switches
      if (input === 'o') { setMode('create'); return; }
      if (input === 'S') { setMode('setup'); return; }
      if (input === '/') { setMode('search'); return; }
      if (input === '?') { setMode('help'); return; }
    }
  }, { isActive: mode === 'board' || mode === 'detail' || mode === 'help' });

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => refresh(), 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Loading state
  if (loading && allIssues.length === 0) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: 'cyan', bold: true }, '🎯 Dev-Maestro TUI'),
      h(Text, { dimColor: true }, 'Loading board data...')
    );
  }

  // Error state
  if (error) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: 'red' }, `Error: ${error}`),
      h(Text, { dimColor: true }, 'Is bd installed? Try: bd list')
    );
  }

  // Layout dimensions
  const detailVisible = showDetail && selectedIssue;
  const detailWidth = detailVisible ? Math.min(40, Math.floor(termWidth * 0.35)) : 0;
  const listWidth = termWidth - detailWidth;
  // Reserve: header(3) + filterbar(1) + statusbar(3) + borders(2) = ~9 lines
  const listHeight = Math.max(5, termHeight - 9);

  return h(Box, { flexDirection: 'column', width: termWidth, height: termHeight },
    // Header
    h(Header, { stats, termWidth }),

    // Filter bar
    h(FilterBar, { filters: filtersWithCounts, activeFilter }),

    // Main content: list + optional detail
    h(Box, { flexDirection: 'row', flexGrow: 1 },
      // Task list
      h(Box, { width: listWidth, flexShrink: 0, borderStyle: 'single', borderColor: 'gray' },
        h(TaskList, {
          issues: filteredIssues,
          selectedIndex,
          width: listWidth - 2,   // account for border
          height: listHeight,
          blockedIds,
          viewMode,
        }),
      ),
      // Detail panel
      detailVisible
        ? h(DetailPanel, { issue: selectedIssue, width: detailWidth })
        : null,
    ),

    // Status bar
    h(StatusBar, { message, mode: showDetail ? 'detail' : mode, selectedIssue }),

    // Overlays
    mode === 'help' ? h(HelpOverlay) : null,
    mode === 'search' ? h(SearchOverlay, {
      columns,
      onSelect: (issue) => {
        // Find issue in current filtered list, or switch to ALL filter
        let idx = filteredIssues.findIndex(i => i.id === issue.id);
        if (idx < 0) {
          setActiveFilter('all');
          // Will need to find after filter change — set to 0 for now
          idx = 0;
          // Try to find in all non-closed
          const allFiltered = applyFilter('all', allIssues, readyIds, blockedIds);
          const foundIdx = allFiltered.findIndex(i => i.id === issue.id);
          if (foundIdx >= 0) idx = foundIdx;
        }
        setSelectedIndex(idx);
        setMode('board');
      },
      onClose: () => setMode('board'),
    }) : null,
    mode === 'create' ? h(CreateOverlay, {
      onCreated: () => { refresh(); setMode('board'); showMsg('Task created!'); },
      onClose: () => setMode('board'),
    }) : null,
    mode === 'setup' ? h(SetupWizard, {
      onDone: () => { setMode('board'); showMsg('Setup complete!'); },
      onCancel: () => setMode('board'),
    }) : null,
  );
}
