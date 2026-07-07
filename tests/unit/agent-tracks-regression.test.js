import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const apiSource = fs.readFileSync(path.join(repoRoot, 'controlroom/api.js'), 'utf8');
const flowSource = fs.readFileSync(path.join(repoRoot, 'flow/index.html'), 'utf8');

describe('active agent tracks regression coverage', () => {
    it('includes Codex JSONL activity in combined changelog entries', () => {
        expect(apiSource).toContain('const CODEX_SESSIONS_DIR');
        expect(apiSource).toContain('function readCodexEntries(days, projectFilter)');
        expect(apiSource).toMatch(/\.concat\(readCodexEntries\(days, projectFilter\)\)/);
    });

    it('keeps Bina-style T task tags in active-session attribution', () => {
        expect(apiSource).toMatch(/\(\?:TASK\|BUG\|ROAD\|IDEA\|ISSUE\|FEATURE\|FEAT\|T\)-\\d\+/);
    });

    it('uses safe live process detection for idle Codex and Claude sessions', () => {
        expect(apiSource).toContain('function getOmxSessionIdsByPid(cwd)');
        expect(apiSource).toContain("path.join(cwd, '.omx', 'logs')");
        expect(apiSource).toContain('function getLiveAgentProcesses(cwd)');
        expect(apiSource).toContain("fs.realpathSync(path.join(procDir, pid, 'cwd'))");
        expect(apiSource).toContain("fs.readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8')");
        expect(apiSource).not.toContain("path.join(procDir, pid, 'environ')");
    });

    it('renders multiple session tracks instead of one runtime per lane', () => {
        expect(flowSource).toContain('let liveSessions = []');
        expect(flowSource).toContain('function fetchActiveSessions(projectRoot)');
        expect(flowSource).toContain('sessionTracks');
        expect(flowSource).toContain('function renderAgentTracks(tracks, taskById)');
        expect(flowSource).toContain('function renderUnassignedAgentRow(tracks, taskById)');
    });

    it('renders task descriptions with live agent tracks', () => {
        expect(flowSource).toContain('function mergeTaskDetails(apiTasks, parsedTasks)');
        expect(flowSource).toContain('mergeTaskDetails(apiTasks, parsedTasks)');
        expect(flowSource).toContain('function formatTaskLabel(taskId, taskById)');
        expect(flowSource).toContain('taskLabels');
        expect(flowSource).toContain('renderAgentTracks(line.sessionTracks, taskById)');
        expect(flowSource).toContain('renderAgentTracks(tracks, taskById)');
    });

    it('renders each live agent as its own flow row', () => {
        expect(flowSource).toContain('function buildActiveInstanceRows(lineStates, taskById)');
        expect(flowSource).toContain('function renderAgentFlowRow(instance, taskById)');
        expect(flowSource).toContain('activeInstances.map(instance => renderAgentFlowRow(instance, taskById))');
    });

    it('does not block the default lane renderer on the graph layout CDN', () => {
        expect(flowSource).toContain('<script async src="https://cdn.jsdelivr.net/npm/@dagrejs/dagre@1.1.4/dist/dagre.min.js"></script>');
    });

    it('persists explicit task assignments for live sessions without task tags', () => {
        expect(apiSource).toContain('const SESSION_ASSIGNMENTS_FILE');
        expect(apiSource).toContain('function applySessionAssignments(sessions, cwd)');
        expect(apiSource).toContain("app.post('/api/session-assignments'");
        expect(apiSource).toContain('assignmentSource');
    });

    it('renders untagged live agents as assignable per-agent rows instead of a bucket', () => {
        expect(flowSource).toContain('function renderUnassignedAgentFlowRow(track, taskById)');
        expect(flowSource).toContain('unassignedSessions.map(track => renderUnassignedAgentFlowRow(track, taskById))');
        expect(flowSource).toContain('data-action="assign-session-task"');
        expect(flowSource).toContain('async function assignSessionTask(sid, taskId)');
    });
});
