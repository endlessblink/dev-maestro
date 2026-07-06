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
        expect(flowSource).toContain('function renderAgentTracks(tracks)');
        expect(flowSource).toContain('function renderUnassignedAgentRow(tracks)');
    });
});
