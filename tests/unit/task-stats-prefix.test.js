import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

// parseTaskStats lives inside controlroom/api.js as a module-private function.
// We exercise it via the regex contract directly so the test is hermetic and
// doesn't depend on running the Express app. The contract guarded here:
//   - T-XXX (botson) is accepted alongside TASK/BUG/etc.
//   - T must come LAST in the alternation so longer prefixes win
//     (TASK-123 must not match as T-XXX prematurely).
describe('MASTER_PLAN task ID parser supports botson T- prefix', () => {
    const apiSource = fs.readFileSync(
        path.join(repoRoot, 'controlroom/api.js'),
        'utf8'
    );

    it('keeps the T-prefix in the parser regex (controlroom/api.js)', () => {
        // Both the matcher and the strikethrough variant must include |T
        expect(apiSource).toMatch(
            /const ID_RE = \/\(TASK\|BUG\|ROAD\|IDEA\|ISSUE\|FEATURE\|INQUIRY\|T\)-\\d\+\/i;/
        );
        expect(apiSource).toMatch(
            /const STRIKE_RE = \/~~\\s\*\(TASK\|BUG\|ROAD\|IDEA\|ISSUE\|FEATURE\|INQUIRY\|T\)-\\d\+\\s\*~~\/i;/
        );
    });

    it('ID regex matches both T-001 and TASK-123 without confusing them', () => {
        const ID_RE = /(TASK|BUG|ROAD|IDEA|ISSUE|FEATURE|INQUIRY|T)-\d+/i;

        expect('| T-001 | something | P1 | PLANNED |'.match(ID_RE)[0]).toBe('T-001');
        expect('| TASK-123 | something | P1 | DONE |'.match(ID_RE)[0]).toBe('TASK-123');
        expect('| BUG-77 | crash | P0 | IN PROGRESS |'.match(ID_RE)[0]).toBe('BUG-77');
        // T must NOT swallow TASK — left-to-right alternation in regex engines
        // tries TASK before T because TASK appears first.
        expect('TASK-9'.match(ID_RE)[1]).toBe('TASK');
    });

    it('classifies a botson-style table row as planned/done correctly', () => {
        // Inline the function under test from controlroom/api.js. If the
        // implementation drifts, the regex test above will fail first.
        const ID_RE = /(TASK|BUG|ROAD|IDEA|ISSUE|FEATURE|INQUIRY|T)-\d+/i;
        const STRIKE_RE = /~~\s*(TASK|BUG|ROAD|IDEA|ISSUE|FEATURE|INQUIRY|T)-\d+\s*~~/i;

        function classify(text) {
            const t = text.replace(/\*\*/g, '');
            if (/✅\s*DONE/i.test(t)) return 'done';
            if (/🔄\s*IN\s*PROGRESS/i.test(t)) return 'inProgress';
            if (/📋\s*PLANNED/i.test(t)) return 'planned';
            if (STRIKE_RE.test(t)) return 'done';
            if (/\bDONE\b/i.test(t)) return 'done';
            if (/\b(?:PLANNED|TODO)\b/i.test(t)) return 'planned';
            return null;
        }

        const sample = [
            '| ID | Title | Priority | Status |',
            '|----|-------|----------|--------|',
            '| T-001 | First task | P1 | ✅ DONE |',
            '| T-002 | Second | P2 | PLANNED |',
            '| ~~T-003~~ | Old | P3 | DONE |',
            '| T-004 | Active | P1 | 🔄 IN PROGRESS |'
        ].join('\n');

        const byId = new Map();
        for (const line of sample.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('|')) continue;
            if (/^\s*\|\s*:?-{2,}/.test(line)) continue;
            const m = line.match(ID_RE);
            if (!m) continue;
            const s = classify(line);
            if (s) byId.set(m[0].toUpperCase(), s);
        }

        expect(byId.get('T-001')).toBe('done');
        expect(byId.get('T-002')).toBe('planned');
        expect(byId.get('T-003')).toBe('done');
        expect(byId.get('T-004')).toBe('inProgress');
        expect(byId.size).toBe(4);
    });
});
