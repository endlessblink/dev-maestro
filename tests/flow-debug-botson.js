#!/usr/bin/env node
'use strict';

/**
 * One-off diagnostic: load the Flow tab pointed at botson and capture every
 * `[FlowDebug]` console event, plus any uncaught errors and a final DOM
 * snapshot of the lane / backlog regions. Not a regression test — meant to
 * answer "why do botson tasks flicker and disappear?"
 *
 * Run: NODE_PATH=$(npm root -g) node tests/flow-debug-botson.js
 */

const { chromium } = require('playwright');

const FLOW_URL = process.env.FLOW_URL || 'http://localhost:6010/flow/';
const BOTSON_ROOT = process.env.BOTSON_ROOT
    || '/media/endlessblink/data/my-projects/ai-development/bots+automation/botson';
const SETTLE_MS = Number(process.env.SETTLE_MS || 6000);
const SCREENSHOT_PATH = '/tmp/flow-botson.png';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();

    const logs = [];
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('[FlowDebug]') || text.includes('[Flow ') || msg.type() === 'error' || msg.type() === 'warning') {
            logs.push({ type: msg.type(), text });
        }
    });
    page.on('pageerror', err => {
        logs.push({ type: 'pageerror', text: `${err.message}\n${err.stack || ''}` });
    });

    console.log(`navigate → ${FLOW_URL}`);
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Initial settle (the page does its own initial fetch/render against Watchpost's own MASTER_PLAN).
    await page.waitForTimeout(2500);

    console.log(`postMessage switch-project → ${BOTSON_ROOT}`);
    await page.evaluate(root => {
        window.postMessage({ type: 'switch-project', projectRoot: root }, '*');
    }, BOTSON_ROOT);

    // Let fetchAndRender + render cycle complete.
    await page.waitForTimeout(SETTLE_MS);

    // Snapshot key DOM counts so we know what's actually visible to the user.
    const domSnapshot = await page.evaluate(() => {
        const q = sel => document.querySelectorAll(sel).length;
        const text = sel => (document.querySelector(sel)?.textContent || '').trim().slice(0, 200);
        return {
            url: location.href,
            graphPaneDisplay: getComputedStyle(document.getElementById('graph') || document.body).display,
            sprintLayoutHidden: !!document.getElementById('sprint-layout')?.hidden,
            mainHTMLLen: (document.getElementById('sprint-main')?.innerHTML || '').length,
            firstSectionH2: text('#sprint-main .flow-section h2'),
            firstSectionEmpty: text('#sprint-main .flow-empty'),
            flowRowCount: q('.flow-row'),
            backlogItemCount: q('.flow-backlog-item'),
            collapsedDetailsCount: q('.flow-collapsed details'),
            taskCardCount: q('.task-card'),
            stat: {
                ready: text('#stat-ready'),
                blocked: text('#stat-blocked'),
                active: text('#stat-active'),
                review: text('#stat-review'),
                overdue: text('#stat-overdue')
            }
        };
    });

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });

    console.log('\n=== captured console events (in order) ===');
    for (const l of logs) {
        const head = l.type.toUpperCase().padEnd(8);
        console.log(`${head} ${l.text}`);
    }

    console.log('\n=== DOM snapshot after settle ===');
    console.log(JSON.stringify(domSnapshot, null, 2));
    console.log(`\nscreenshot saved: ${SCREENSHOT_PATH}`);

    await browser.close();
})().catch(err => {
    console.error('script crashed:', err);
    process.exit(1);
});
