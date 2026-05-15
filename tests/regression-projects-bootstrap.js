'use strict';

/**
 * Regression tests for the projects.json ENOENT crash.
 *
 * Covers:
 *   1. lib/paths.js  — ensureProjectsFile() creates the file with the canonical
 *      shape when it's missing, and is a no-op (preserves contents) when present.
 *   2. server.js     — booting with no projects.json must not crash any HTTP
 *      handler, including findProjectForCwd's auto-discovery write-back path
 *      that historically did an unguarded JSON.parse(readFileSync()).
 *
 * Run with: `npm test` or `node tests/regression-projects-bootstrap.js`.
 *
 * Exits 0 on pass, 1 on any failure. No external test-runner dependency.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const wpPaths = require(path.join(REPO_ROOT, 'lib', 'paths'));

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ok  ${label}`); }
function bad(label, err) { fail++; console.log(`  FAIL ${label}: ${err && err.message || err}`); if (err && err.stack) console.log(err.stack); }
async function test(label, fn) {
    try { await fn(); ok(label); } catch (err) { bad(label, err); }
}

function freshTempDir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `wp-regression-${tag}-`));
}

function getJSON(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body, json: body ? JSON.parse(body) : null }); }
                catch (e) { resolve({ status: res.statusCode, body, parseError: e.message }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    });
}

function waitForListen(port, timeoutMs = 8000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            const sock = require('net').connect({ host: '127.0.0.1', port }, () => {
                sock.end();
                resolve();
            });
            sock.on('error', () => {
                if (Date.now() - start > timeoutMs) return reject(new Error(`server did not listen on :${port} within ${timeoutMs}ms`));
                setTimeout(tick, 100);
            });
        };
        tick();
    });
}

// ─── Unit tests for lib/paths.js:ensureProjectsFile ─────────────────────────

(async function unitTests() {
    console.log('# unit: lib/paths.js:ensureProjectsFile');

    await test('creates file with canonical shape when missing', () => {
        const dir = freshTempDir('unit-create');
        const file = path.join(dir, 'sub', 'projects.json');
        process.env.WATCHPOST_PROJECTS_FILE = file;
        delete require.cache[require.resolve(path.join(REPO_ROOT, 'lib', 'paths'))];
        const wp = require(path.join(REPO_ROOT, 'lib', 'paths'));
        const result = wp.ensureProjectsFile();
        assert.strictEqual(result.created, true, 'first call should report created:true');
        assert.strictEqual(result.path, file);
        assert.ok(fs.existsSync(file), 'file should exist');
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepStrictEqual(parsed, { projects: [], pathMappings: [] });
    });

    await test('idempotent: second call is a no-op and preserves contents', () => {
        const dir = freshTempDir('unit-idempotent');
        const file = path.join(dir, 'projects.json');
        const customContents = { projects: [{ name: 'preexisting', root: '/x' }], pathMappings: [{ linux: '/a', windows: 'A:\\' }] };
        fs.writeFileSync(file, JSON.stringify(customContents, null, 2));
        process.env.WATCHPOST_PROJECTS_FILE = file;
        delete require.cache[require.resolve(path.join(REPO_ROOT, 'lib', 'paths'))];
        const wp = require(path.join(REPO_ROOT, 'lib', 'paths'));
        const result = wp.ensureProjectsFile();
        assert.strictEqual(result.created, false, 'second call should report created:false');
        const after = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepStrictEqual(after, customContents, 'contents must be preserved verbatim');
    });

    delete process.env.WATCHPOST_PROJECTS_FILE;

    console.log('');
})()
    .then(() => integrationTests())
    .then(() => {
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail === 0 ? 0 : 1);
    })
    .catch(err => {
        console.error('test harness crashed:', err);
        process.exit(2);
    });

// ─── Integration tests: spawn the real server ───────────────────────────────

async function integrationTests() {
    console.log('# integration: server.js boot with missing projects.json');

    const dir = freshTempDir('int');
    const projectsFile = path.join(dir, 'projects.json');
    assert.ok(!fs.existsSync(projectsFile), 'precondition: file must not exist');

    const port = 6099;
    const env = {
        ...process.env,
        PORT: String(port),
        WATCHPOST_PROJECTS_FILE: projectsFile,
        // Don't let the test inherit the user's MASTER_PLAN_PATH from .env.
        MASTER_PLAN_PATH: ''
    };
    delete env.WATCHPOST_DIR;

    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, ['server.js'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    let earlyExit = null;
    child.on('exit', (code, signal) => { earlyExit = { code, signal }; });

    try {
        await waitForListen(port);

        await test('server boots without crashing when projects.json is missing', () => {
            assert.strictEqual(earlyExit, null, `server exited early: ${JSON.stringify(earlyExit)}\nstderr: ${stderr}`);
        });

        await test('startup log shows [Bootstrap] line', () => {
            assert.match(stdout, /\[Bootstrap\] Created empty projects\.json/, 'expected bootstrap log line in stdout');
        });

        await test('bootstrap created the file with canonical shape', () => {
            assert.ok(fs.existsSync(projectsFile), 'projects.json must exist after boot');
            const parsed = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
            // Startup discovery may populate `projects` from Claude transcripts on
            // machines that have any. The shape contract is: object with a
            // `projects` array (and optional `pathMappings` array). We don't assert
            // emptiness because that's environment-dependent now.
            assert.ok(parsed && typeof parsed === 'object', 'must be an object');
            assert.ok(Array.isArray(parsed.projects), 'projects must be an array');
        });

        await test('GET /api/status returns 200 with the empty registry', async () => {
            const res = await getJSON(`http://127.0.0.1:${port}/api/status?cwd=${encodeURIComponent(REPO_ROOT)}`);
            assert.strictEqual(res.status, 200, `status: ${res.status}, body: ${res.body.slice(0, 200)}`);
            assert.ok(res.json && res.json.running === true, 'response should report running:true');
        });

        await test('auto-discovery write-back path tolerates an absent file (the original crash site)', async () => {
            // Force the write-back code path: delete the bootstrap-created file at runtime,
            // then hit an endpoint that walks findProjectForCwd against a git-rooted cwd
            // not yet in the registry. Pre-fix, this throws ENOENT at server.js:295 and 500s.
            fs.rmSync(projectsFile, { force: true });
            assert.ok(!fs.existsSync(projectsFile), 'file removed before request');

            const freshCwd = REPO_ROOT;  // dev tree itself — has .git, so triggers auto-add.
            const res = await getJSON(`http://127.0.0.1:${port}/api/master-plan?cwd=${encodeURIComponent(freshCwd)}`);
            assert.notStrictEqual(res.status, 500, `expected non-500, got ${res.status}\nbody: ${res.body.slice(0, 300)}`);
            assert.ok(fs.existsSync(projectsFile), 'auto-discovery should have re-created projects.json');
            const parsed = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
            const projects = Array.isArray(parsed) ? parsed : (parsed.projects || []);
            assert.ok(projects.some(p => p.root === freshCwd), 'auto-discovered cwd should be in the registry');
        });
    } finally {
        if (earlyExit === null) {
            child.kill('SIGTERM');
            await new Promise(resolve => child.once('exit', resolve));
        }
    }
}
