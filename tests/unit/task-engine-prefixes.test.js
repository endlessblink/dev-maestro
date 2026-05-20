import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const taskEngine = require('../../modules/task-engine.js');

let tempDir = null;

afterEach(() => {
    taskEngine.closeDb();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
});

describe('task engine project-specific task IDs', () => {
    it('syncs GTV table rows with lanes and dependencies', () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchpost-gtv-'));
        const masterPlanPath = path.join(tempDir, 'MASTER_PLAN.md');
        const dbPath = path.join(tempDir, '.watchpost', 'db.sqlite');

        fs.writeFileSync(masterPlanPath, [
            '| ID | Lane | Task | Status | Priority | Deps |',
            '|----|------|------|--------|----------|------|',
            '| GTV-001 | Trust & Memory | Memory review UI | DONE | P0 | — |',
            '| GTV-002 | Trust & Memory | `/forget` command | TODO | P0 | GTV-001 |',
            '',
            '### GTV-002 — /forget command',
            '**Status:** TODO',
            '**Priority:** P0',
            '',
            '### GTV-003 — Memory provenance metadata',
            '**Status:** TODO',
            '**Priority:** P1',
        ].join('\n'));

        taskEngine.initDb(dbPath);
        expect(taskEngine.syncFromMarkdown(masterPlanPath)).toBe(3);

        const graph = taskEngine.getGraph();
        expect(graph.nodes.map(node => node.id)).toEqual(['GTV-001', 'GTV-002', 'GTV-003']);
        expect(graph.nodes.find(node => node.id === 'GTV-002')?.title).toBe('/forget command');
        expect(graph.nodes.find(node => node.id === 'GTV-002')?.lane).toBe('Trust & Memory');
        expect(graph.nodes.find(node => node.id === 'GTV-003')?.title).toBe('Memory provenance metadata');
        expect(graph.links).toEqual([{ target: 'GTV-002', source: 'GTV-001' }]);
    });
});
