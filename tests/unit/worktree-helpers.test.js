/**
 * Unit tests for Watchpost worktree helper operations.
 *
 * These tests replicate the git operations from server.js
 * (createAgentWorktree, cleanupWorktree, cleanupStaleWorktrees, merge endpoint)
 * in isolation using temporary git repos.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Helpers — mirror server.js logic exactly
// ---------------------------------------------------------------------------

function createAgentWorktree(projectRoot, taskId) {
    const worktreePath = path.join(projectRoot, '.agent-worktrees', taskId);
    const branchName = `bd-${taskId}`;

    const worktreesDir = path.join(projectRoot, '.agent-worktrees');
    if (!fs.existsSync(worktreesDir)) {
        fs.mkdirSync(worktreesDir, { recursive: true });
    }

    if (fs.existsSync(worktreePath)) {
        return { worktreePath, branchName, created: false };
    }

    // Create branch if not exists
    try {
        execSync(`git branch ${branchName}`, { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch {
        // branch may already exist
    }

    execSync(`git worktree add "${worktreePath}" ${branchName}`, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe',
    });

    return { worktreePath, branchName, created: true };
}

function cleanupWorktree(projectRoot, taskId) {
    const worktreePath = path.join(projectRoot, '.agent-worktrees', taskId);

    if (fs.existsSync(worktreePath)) {
        execSync(`git worktree remove "${worktreePath}" --force`, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: 'pipe',
        });
    }
}

function mergeAndCleanup(projectRoot, taskId) {
    const branchName = `bd-${taskId}`;

    const currentBranch = execSync('git branch --show-current', {
        cwd: projectRoot,
        encoding: 'utf8',
    }).trim();

    if (currentBranch !== 'master' && currentBranch !== 'main') {
        execSync('git checkout master', { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    }

    execSync(`git merge ${branchName} --no-ff -m "Merge ${branchName}: Task completed"`, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe',
    });

    cleanupWorktree(projectRoot, taskId);

    try {
        execSync(`git branch -d ${branchName}`, { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch {
        // ignore
    }
}

function cleanupStaleWorktrees(projectRoot, maxAgeMs) {
    const worktreesDir = path.join(projectRoot, '.agent-worktrees');
    const results = { cleaned: [], failed: [], skipped: [] };

    if (!fs.existsSync(worktreesDir)) return results;

    const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const worktreePath = path.join(worktreesDir, entry.name);
        const stats = fs.statSync(worktreePath);
        const ageMs = now - stats.mtimeMs;

        if (ageMs > maxAgeMs) {
            try {
                execSync(`git worktree remove "${worktreePath}" --force`, {
                    cwd: projectRoot,
                    encoding: 'utf8',
                    stdio: 'pipe',
                });
                results.cleaned.push(entry.name);
            } catch {
                try {
                    fs.rmSync(worktreePath, { recursive: true, force: true });
                    results.cleaned.push(entry.name);
                } catch (e) {
                    results.failed.push(entry.name);
                }
            }
        } else {
            results.skipped.push(entry.name);
        }
    }

    try {
        execSync('git worktree prune', { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* ignore */ }

    // Clean orphaned bd-* branches
    try {
        const branches = execSync('git branch', { cwd: projectRoot, encoding: 'utf8' })
            .split('\n')
            .map(b => b.trim().replace('* ', ''))
            .filter(b => b.startsWith('bd-'));

        for (const branch of branches) {
            const tid = branch.replace('bd-', '');
            const wt = path.join(worktreesDir, tid);
            if (!fs.existsSync(wt)) {
                try {
                    execSync(`git branch -D ${branch}`, { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }

    return results;
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function initTestRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-test-'));
    execSync('git init --initial-branch=master .', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'initial');
    execSync('git add file.txt && git commit -m "Initial commit"', { cwd: dir, stdio: 'pipe' });
    return dir;
}

function branchExists(projectRoot, branchName) {
    const output = execSync('git branch --list', { cwd: projectRoot, encoding: 'utf8' });
    return output.includes(branchName);
}

function destroyTestRepo(dir) {
    if (dir && fs.existsSync(dir)) {
        execSync('git worktree prune', { cwd: dir, stdio: 'pipe' }).toString();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAgentWorktree', () => {
    let repo;
    beforeEach(() => { repo = initTestRepo(); });
    afterEach(() => { destroyTestRepo(repo); });

    it('creates worktree directory and branch', () => {
        const result = createAgentWorktree(repo, 'TASK-100');
        expect(result.created).toBe(true);
        expect(result.branchName).toBe('bd-TASK-100');
        expect(fs.existsSync(result.worktreePath)).toBe(true);
        expect(branchExists(repo, 'bd-TASK-100')).toBe(true);
    });

    it('worktree is checked out on the correct branch', () => {
        const result = createAgentWorktree(repo, 'TASK-101');
        const branch = execSync('git branch --show-current', {
            cwd: result.worktreePath,
            encoding: 'utf8',
        }).trim();
        expect(branch).toBe('bd-TASK-101');
    });

    it('returns created=false for existing worktree', () => {
        createAgentWorktree(repo, 'TASK-102');
        const second = createAgentWorktree(repo, 'TASK-102');
        expect(second.created).toBe(false);
    });

    it('multiple worktrees are isolated', () => {
        const a = createAgentWorktree(repo, 'TASK-103');
        const b = createAgentWorktree(repo, 'TASK-104');

        fs.writeFileSync(path.join(a.worktreePath, 'a.txt'), 'a');
        execSync('git add a.txt && git commit -m "a"', { cwd: a.worktreePath, stdio: 'pipe' });

        expect(fs.existsSync(path.join(b.worktreePath, 'a.txt'))).toBe(false);
        expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);
    });
});

describe('cleanupWorktree', () => {
    let repo;
    beforeEach(() => { repo = initTestRepo(); });
    afterEach(() => { destroyTestRepo(repo); });

    it('removes worktree directory', () => {
        const result = createAgentWorktree(repo, 'TASK-200');
        cleanupWorktree(repo, 'TASK-200');
        expect(fs.existsSync(result.worktreePath)).toBe(false);
    });

    it('does not crash for nonexistent worktree', () => {
        expect(() => cleanupWorktree(repo, 'TASK-NOPE')).not.toThrow();
    });
});

describe('mergeAndCleanup (merge endpoint)', () => {
    let repo;
    beforeEach(() => { repo = initTestRepo(); });
    afterEach(() => { destroyTestRepo(repo); });

    it('merges branch changes to master', () => {
        const result = createAgentWorktree(repo, 'TASK-300');
        fs.writeFileSync(path.join(result.worktreePath, 'feature.txt'), 'hello');
        execSync('git add feature.txt && git commit -m "Add feature"', {
            cwd: result.worktreePath,
            stdio: 'pipe',
        });

        mergeAndCleanup(repo, 'TASK-300');

        expect(fs.existsSync(path.join(repo, 'feature.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8')).toBe('hello');
    });

    it('creates a merge commit with --no-ff', () => {
        const result = createAgentWorktree(repo, 'TASK-301');
        fs.writeFileSync(path.join(result.worktreePath, 'f.txt'), 'x');
        execSync('git add f.txt && git commit -m "feat"', { cwd: result.worktreePath, stdio: 'pipe' });

        mergeAndCleanup(repo, 'TASK-301');

        const log = execSync('git log --oneline -1', { cwd: repo, encoding: 'utf8' });
        expect(log).toContain('Merge bd-TASK-301');
    });

    it('removes worktree directory after merge', () => {
        const result = createAgentWorktree(repo, 'TASK-302');
        fs.writeFileSync(path.join(result.worktreePath, 'f.txt'), 'x');
        execSync('git add f.txt && git commit -m "feat"', { cwd: result.worktreePath, stdio: 'pipe' });

        mergeAndCleanup(repo, 'TASK-302');

        expect(fs.existsSync(result.worktreePath)).toBe(false);
    });

    it('deletes branch after merge', () => {
        const result = createAgentWorktree(repo, 'TASK-303');
        fs.writeFileSync(path.join(result.worktreePath, 'f.txt'), 'x');
        execSync('git add f.txt && git commit -m "feat"', { cwd: result.worktreePath, stdio: 'pipe' });

        mergeAndCleanup(repo, 'TASK-303');

        expect(branchExists(repo, 'bd-TASK-303')).toBe(false);
    });

    it('preserves other worktrees when merging one', () => {
        const a = createAgentWorktree(repo, 'TASK-310');
        createAgentWorktree(repo, 'TASK-311');

        fs.writeFileSync(path.join(a.worktreePath, 'f.txt'), 'x');
        execSync('git add f.txt && git commit -m "feat"', { cwd: a.worktreePath, stdio: 'pipe' });

        mergeAndCleanup(repo, 'TASK-310');

        expect(fs.existsSync(path.join(repo, '.agent-worktrees', 'TASK-311'))).toBe(true);
        expect(branchExists(repo, 'bd-TASK-311')).toBe(true);
    });

    it('fails gracefully on merge conflict', () => {
        const result = createAgentWorktree(repo, 'TASK-320');

        // Change file.txt on branch
        fs.writeFileSync(path.join(result.worktreePath, 'file.txt'), 'branch');
        execSync('git add file.txt && git commit -m "branch"', { cwd: result.worktreePath, stdio: 'pipe' });

        // Change file.txt on master (diverge)
        fs.writeFileSync(path.join(repo, 'file.txt'), 'master');
        execSync('git add file.txt && git commit -m "master"', { cwd: repo, stdio: 'pipe' });

        expect(() => mergeAndCleanup(repo, 'TASK-320')).toThrow();

        // Abort merge state
        execSync('git merge --abort', { cwd: repo, stdio: 'pipe' });
    });
});

describe('discard workflow (cleanup without merge)', () => {
    let repo;
    beforeEach(() => { repo = initTestRepo(); });
    afterEach(() => { destroyTestRepo(repo); });

    it('master is unchanged after discard', () => {
        const hashBefore = execSync('git rev-parse master', { cwd: repo, encoding: 'utf8' }).trim();

        const result = createAgentWorktree(repo, 'TASK-400');
        fs.writeFileSync(path.join(result.worktreePath, 'discard.txt'), 'gone');
        execSync('git add discard.txt && git commit -m "discard"', { cwd: result.worktreePath, stdio: 'pipe' });

        cleanupWorktree(repo, 'TASK-400');

        const hashAfter = execSync('git rev-parse master', { cwd: repo, encoding: 'utf8' }).trim();
        expect(hashAfter).toBe(hashBefore);
        expect(fs.existsSync(path.join(repo, 'discard.txt'))).toBe(false);
    });
});

describe('cleanupStaleWorktrees', () => {
    let repo;
    beforeEach(() => { repo = initTestRepo(); });
    afterEach(() => { destroyTestRepo(repo); });

    it('removes old worktrees and keeps fresh ones', () => {
        createAgentWorktree(repo, 'TASK-500');
        createAgentWorktree(repo, 'TASK-501');

        // Backdate TASK-500
        const oldPath = path.join(repo, '.agent-worktrees', 'TASK-500');
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(oldPath, twoHoursAgo, twoHoursAgo);

        // Threshold: 1 hour
        const results = cleanupStaleWorktrees(repo, 1 * 60 * 60 * 1000);

        expect(results.cleaned).toContain('TASK-500');
        expect(results.skipped).toContain('TASK-501');
        expect(fs.existsSync(oldPath)).toBe(false);
        expect(fs.existsSync(path.join(repo, '.agent-worktrees', 'TASK-501'))).toBe(true);
    });

    it('deletes orphaned bd-* branches', () => {
        createAgentWorktree(repo, 'TASK-510');

        // Remove worktree dir manually, leaving orphan branch
        const wtPath = path.join(repo, '.agent-worktrees', 'TASK-510');
        fs.rmSync(wtPath, { recursive: true, force: true });
        execSync('git worktree prune', { cwd: repo, stdio: 'pipe' });

        expect(branchExists(repo, 'bd-TASK-510')).toBe(true);

        cleanupStaleWorktrees(repo, 0);

        expect(branchExists(repo, 'bd-TASK-510')).toBe(false);
    });

    it('handles missing .agent-worktrees directory', () => {
        const results = cleanupStaleWorktrees(repo, 0);
        expect(results.cleaned).toHaveLength(0);
    });
});
