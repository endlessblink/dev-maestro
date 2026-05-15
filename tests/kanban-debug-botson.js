#!/usr/bin/env node
'use strict';

/**
 * One-off diagnostic: load the Kanban tab pointed at botson and verify task
 * cards render. Counterpart to tests/flow-debug-botson.js.
 *
 * Run: NODE_PATH=$(npm root -g) node tests/kanban-debug-botson.js
 */

const { chromium } = require('playwright');

const KANBAN_URL = process.env.KANBAN_URL || 'http://localhost:6010/kanban/';
const BOTSON_ROOT = process.env.BOTSON_ROOT
    || '/media/endlessblink/data/my-projects/ai-development/bots+automation/botson';
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000);
const SCREENSHOT_PATH = '/tmp/kanban-botson.png';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 } });
    const page = await ctx.newPage();

    const logs = [];
    page.on('console', msg => {
        const text = msg.text();
        // Capture everything noisy enough to diagnose with — kanban has no [FlowDebug] tag yet.
        if (msg.type() === 'error' || msg.type() === 'warning' || /TASK-|T-\d|botson|empty|0 tasks|Status Board/i.test(text)) {
            logs.push({ type: msg.type(), text });
        }
    });
    page.on('pageerror', err => {
        logs.push({ type: 'pageerror', text: `${err.message}\n${err.stack || ''}` });
    });

    console.log(`navigate → ${KANBAN_URL}`);
    await page.goto(KANBAN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    console.log(`postMessage switch-project → ${BOTSON_ROOT}`);
    await page.evaluate(root => {
        window.postMessage({ type: 'switch-project', projectRoot: root }, '*');
    }, BOTSON_ROOT);
    await page.waitForTimeout(SETTLE_MS);

    const snap = await page.evaluate(() => {
        const q = sel => document.querySelectorAll(sel).length;
        const text = sel => (document.querySelector(sel)?.textContent || '').trim().slice(0, 100);
        // Try a bunch of plausible card/column selectors so we don't miss the actual class.
        const candidates = ['.kanban-card', '.task-card', '.card', '[data-task-id]', '.kanban-column .item', '.column .task'];
        const counts = Object.fromEntries(candidates.map(sel => [sel, q(sel)]));
        const colTexts = [...document.querySelectorAll('.kanban-column, .column, [data-column], .status-column')].slice(0, 6).map(c => c.textContent.trim().slice(0, 80));
        return {
            url: location.href,
            title: document.title,
            statTotalText: text('#stat-total, .stat-total, .total'),
            statTodoText: text('#stat-todo, .todo'),
            statDoneText: text('#stat-done, .done'),
            cardCounts: counts,
            firstFiveColumns: colTexts,
            visibleHeadings: [...document.querySelectorAll('h1, h2, h3')].slice(0, 6).map(h => h.textContent.trim().slice(0, 80)),
            anyHebrew: /[֐-׿]/.test(document.body.textContent || '')
        };
    });

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

    console.log('\n=== captured console events (filtered) ===');
    if (logs.length === 0) console.log('(none — no errors or noteworthy logs)');
    for (const l of logs) console.log(`${l.type.toUpperCase().padEnd(8)} ${l.text}`);

    console.log('\n=== DOM snapshot ===');
    console.log(JSON.stringify(snap, null, 2));
    console.log(`\nscreenshot saved: ${SCREENSHOT_PATH}`);

    await browser.close();
})().catch(err => {
    console.error('script crashed:', err);
    process.exit(1);
});
