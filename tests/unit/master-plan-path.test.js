import { describe, expect, it } from 'vitest';
import path from 'path';
import { resolveMasterPlanPath } from '../../modules/master-plan-path.js';

describe('resolveMasterPlanPath', () => {
    const rootDir = '/repo/watchpost';

    it('falls back to local config when the env path is stale', () => {
        const validLocalPath = '/projects/flow-state/docs/MASTER_PLAN.md';
        const result = resolveMasterPlanPath({
            envPath: '/missing/project/MASTER_PLAN.md',
            localConfig: { masterPlanPath: validLocalPath },
            rootDir,
            existsSync: candidate => candidate === validLocalPath
        });

        expect(result.path).toBe(validLocalPath);
        expect(result.source).toBe('local-config');
        expect(result.exists).toBe(true);
        expect(result.configuredPath).toBe('/missing/project/MASTER_PLAN.md');
        expect(result.configuredSource).toBe('env');
    });

    it('keeps a valid env path ahead of local config', () => {
        const envPath = '/projects/current/MASTER_PLAN.md';
        const result = resolveMasterPlanPath({
            envPath,
            localConfig: { masterPlanPath: '/projects/other/MASTER_PLAN.md' },
            rootDir,
            existsSync: candidate => candidate === envPath
        });

        expect(result.path).toBe(envPath);
        expect(result.source).toBe('env');
        expect(result.exists).toBe(true);
    });

    it('resolves relative configured paths against the app root', () => {
        const result = resolveMasterPlanPath({
            envPath: 'docs/MASTER_PLAN.md',
            localConfig: {},
            rootDir,
            existsSync: candidate => candidate === path.join(rootDir, 'docs/MASTER_PLAN.md')
        });

        expect(result.path).toBe(path.join(rootDir, 'docs/MASTER_PLAN.md'));
        expect(result.source).toBe('env');
        expect(result.exists).toBe(true);
    });
});
