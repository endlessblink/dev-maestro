import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const readRepoFile = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

describe('Project switcher regression coverage', () => {
    // Guards against the regression where the well-designed project switcher
    // (badge + popover + search + per-project meta) was replaced with a
    // bare <select id="project-select"> that rendered as the native dropdown.
    it('keeps the project-switcher badge + popover markup in the header', () => {
        const html = readRepoFile('index.html');

        expect(html).toContain('id="active-project-badge"');
        expect(html).toContain('id="active-project-badge-name"');
        expect(html).toContain('class="project-switcher-trigger"');
        expect(html).toContain('id="project-switcher-popover"');
        expect(html).toContain('id="project-switcher-search"');
        expect(html).toContain('id="project-switcher-list"');
        expect(html).toContain('id="project-switcher-manage"');

        expect(html).not.toContain('id="project-select"');
        expect(html).not.toContain('id="project-scan-btn"');
    });

    // The popover must paint above the iframe content. The header needs
    // position:relative and z-index >= the popover's z-index (60).
    it('keeps the header above iframes so the popover is visible', () => {
        const html = readRepoFile('index.html');

        const headerBlock = html.match(/\.header\s*\{[^}]*\}/);
        expect(headerBlock, '.header CSS block missing').not.toBeNull();
        expect(headerBlock[0]).toMatch(/position:\s*relative/);
        expect(headerBlock[0]).toMatch(/z-index:\s*50/);

        // Popover should be z-index 60 (above the header's stacking context)
        expect(html).toMatch(/\.project-switcher-popover\s*\{[\s\S]*?z-index:\s*60/);
    });

    it('wires the switcher to the activate API and broadcasts to iframes', () => {
        const html = readRepoFile('index.html');

        expect(html).toContain("'/api/projects/'");
        expect(html).toContain("'/activate'");
        expect(html).toContain('/api/projects/enriched');
        expect(html).toContain('broadcastProjectSwitch');
        expect(html).toContain("switchTab('kanban')");
        expect(html).toContain("switchTab('projects')"); // Manage all → Projects tab
    });

    it('supports keyboard nav + search filtering in the popover', () => {
        const html = readRepoFile('index.html');

        // Search input feeds the filter
        expect(html).toMatch(/search\.addEventListener\(\s*'input'/);
        // Arrow keys + Enter + Escape handled
        expect(html).toMatch(/case 'ArrowDown'|e\.key === 'ArrowDown'/);
        expect(html).toMatch(/case 'ArrowUp'|e\.key === 'ArrowUp'/);
        expect(html).toMatch(/case 'Enter'|e\.key === 'Enter'/);
        expect(html).toMatch(/case 'Escape'|e\.key === 'Escape'/);
    });

    it('keeps Control Room cards switching the active project on click', () => {
        const html = readRepoFile('controlroom/index.html');

        // Activate handler, not openDetail-on-click
        expect(html).toContain('async function activateProject(name)');
        expect(html).toContain("'/api/projects/' + encodeURIComponent(name) + '/activate'");
        // Card body click triggers activate, not detail overlay
        expect(html).toContain("action === 'open'");
        expect(html).toContain('activateProject(name)');
        // Parent navigation message
        expect(html).toContain("type: 'activate-and-navigate'");
        expect(html).toContain("target: 'kanban'");
    });

    it('keeps the launcher server detached after the shell exits', () => {
        const launcher = readRepoFile('watchpost');

        expect(launcher).toContain('nohup setsid env WATCHPOST_CWD=');
        expect(launcher).toContain('disown "$pid"');
    });
});
