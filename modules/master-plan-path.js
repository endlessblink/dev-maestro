const path = require('path');

function normalizePlanPath(value, rootDir) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
    if (!trimmed) return null;
    return path.resolve(rootDir, trimmed);
}

function resolveMasterPlanPath({ envPath, localConfig, rootDir, existsSync }) {
    const candidates = [
        { source: 'env', path: normalizePlanPath(envPath, rootDir) },
        { source: 'local-config', path: normalizePlanPath(localConfig && localConfig.masterPlanPath, rootDir) },
        { source: 'default', path: path.join(rootDir, '../docs/MASTER_PLAN.md') }
    ];

    const firstConfigured = candidates.find(candidate => candidate.path) || candidates[candidates.length - 1];
    const found = candidates.find(candidate => candidate.path && existsSync(candidate.path));

    return {
        path: found ? found.path : firstConfigured.path,
        source: found ? found.source : firstConfigured.source,
        exists: Boolean(found),
        configuredPath: firstConfigured.path,
        configuredSource: firstConfigured.source
    };
}

module.exports = {
    resolveMasterPlanPath
};
