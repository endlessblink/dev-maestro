/**
 * Happy Safety Module
 *
 * Provides command approval, audit logging, and project sandboxing
 * for Happy Coder remote sessions.
 *
 * @module happy-safety
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

// Default destructive command patterns
const DEFAULT_DESTRUCTIVE_PATTERNS = [
    // File system destructive
    /rm\s+(-[rf]+\s+)*\//,           // rm -rf / or similar
    /rm\s+-rf\s+\*/,                  // rm -rf *
    /rm\s+-rf\s+~\//,                 // rm -rf ~/

    // Git destructive
    /git\s+push\s+.*--force/,         // git push --force
    /git\s+push\s+-f\b/,              // git push -f
    /git\s+reset\s+--hard/,           // git reset --hard
    /git\s+clean\s+-fd/,              // git clean -fd
    /git\s+branch\s+-D/,              // git branch -D (force delete)

    // Database destructive
    /DROP\s+(DATABASE|TABLE|SCHEMA)/i,
    /DELETE\s+FROM\s+\w+\s*;?\s*$/i,  // DELETE FROM without WHERE
    /TRUNCATE\s+TABLE/i,
    /supabase\s+db\s+reset/,

    // System destructive
    /sudo\s+rm/,
    /chmod\s+-R\s+777/,
    /dd\s+if=/,

    // Publishing/deployment
    /npm\s+publish/,
    /npm\s+unpublish/,
    /docker\s+system\s+prune\s+-a/,

    // Config destructive
    /\.env\b.*>/,                     // Writing to .env
    /ssh-keygen.*-f.*id_rsa/,         // Overwriting SSH keys
];

// Default blocked directories
const DEFAULT_BLOCKED_DIRS = [
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.config/gcloud',
    '/etc',
    '/root',
    '/var',
    '/usr',
    '/boot',
    '/sys',
    '/proc',
];

// Default allowed commands (when in strict mode)
const DEFAULT_ALLOWED_COMMANDS = [
    'npm', 'npx', 'node', 'git', 'claude',
    'ls', 'cat', 'grep', 'find', 'pwd', 'echo',
    'mkdir', 'touch', 'cp', 'mv',
    'python', 'python3', 'pip', 'pip3',
    'cargo', 'rustc',
    'go', 'gofmt',
    'make', 'cmake',
    'docker', 'docker-compose',
    'curl', 'wget',
];

class HappySafety extends EventEmitter {
    constructor(options = {}) {
        super();

        // Configuration paths
        this.configDir = options.configDir || path.join(__dirname, '..', 'local');
        this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
        this.configPath = path.join(this.configDir, 'happy-config.json');
        this.auditPath = path.join(this.dataDir, 'happy-audit.jsonl');

        // Command approval queue: queueId -> { command, sessionId, timestamp, status }
        this.commandQueue = new Map();

        // Load configuration
        this.config = this._loadConfig();
    }

    /**
     * Load safety configuration
     * @private
     */
    _loadConfig() {
        const defaults = {
            // Approval mode: 'auto', 'review-destructive', 'review-all'
            approvalMode: 'review-destructive',

            // Destructive command patterns (regex strings)
            destructivePatterns: DEFAULT_DESTRUCTIVE_PATTERNS.map(r => r.source),

            // Directory restrictions
            allowedDirectories: [
                '~/projects/**',
                '~/dev/**',
                '~/code/**',
                '/media/**',
                '/home/**',
            ],
            blockedDirectories: DEFAULT_BLOCKED_DIRS,

            // Command restrictions (only used in strict mode)
            allowedCommands: DEFAULT_ALLOWED_COMMANDS,
            blockedCommands: ['sudo', 'su', 'passwd', 'chsh'],

            // Session settings
            maxSessionDuration: 4 * 60 * 60 * 1000, // 4 hours
            commandTimeout: 5 * 60 * 1000, // 5 minutes for approval

            // Audit settings
            auditEnabled: true,
            auditRetentionDays: 30,
        };

        try {
            if (fs.existsSync(this.configPath)) {
                const userConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                return { ...defaults, ...userConfig };
            }
        } catch (err) {
            console.error('[HappySafety] Failed to load config:', err.message);
        }

        return defaults;
    }

    /**
     * Save configuration to disk
     */
    saveConfig() {
        try {
            fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
        } catch (err) {
            console.error('[HappySafety] Failed to save config:', err.message);
        }
    }

    /**
     * Update configuration
     * @param {Object} updates Configuration updates
     */
    updateConfig(updates) {
        this.config = { ...this.config, ...updates };
        this.saveConfig();
    }

    /**
     * Check if a command is destructive
     * @param {string} command Command to check
     * @returns {Object} { isDestructive: boolean, matchedPattern?: string }
     */
    isDestructive(command) {
        const patterns = this.config.destructivePatterns.map(p => new RegExp(p, 'i'));

        for (const pattern of patterns) {
            if (pattern.test(command)) {
                return {
                    isDestructive: true,
                    matchedPattern: pattern.source
                };
            }
        }

        return { isDestructive: false };
    }

    /**
     * Check if a path is allowed
     * @param {string} targetPath Path to check
     * @returns {Object} { allowed: boolean, reason?: string }
     */
    isPathAllowed(targetPath) {
        const expandedPath = targetPath.replace(/^~/, process.env.HOME || '/home');
        const normalizedPath = path.normalize(expandedPath);

        // Check blocked directories first
        for (const blocked of this.config.blockedDirectories) {
            const expandedBlocked = blocked.replace(/^~/, process.env.HOME || '/home');
            if (normalizedPath.startsWith(expandedBlocked.replace('/**', ''))) {
                return {
                    allowed: false,
                    reason: `Path is in blocked directory: ${blocked}`
                };
            }
        }

        // Check allowed directories
        const hasAllowedMatch = this.config.allowedDirectories.some(allowed => {
            const expandedAllowed = allowed.replace(/^~/, process.env.HOME || '/home');
            const cleanPattern = expandedAllowed.replace('/**', '');
            return normalizedPath.startsWith(cleanPattern);
        });

        if (!hasAllowedMatch) {
            return {
                allowed: false,
                reason: 'Path is not in any allowed directory'
            };
        }

        return { allowed: true };
    }

    /**
     * Check if a command should be allowed
     * @param {Object} params Check parameters
     * @param {string} params.command Command to check
     * @param {string} params.sessionId Session ID
     * @param {string} params.source Source of command (mobile, desktop)
     * @param {string} params.type Command type (tool_call, file_edit, slash_command)
     * @returns {Object} { allowed: boolean, reason?: string, queueId?: string }
     */
    async checkCommand(params) {
        const { command, sessionId, source = 'unknown', type = 'unknown' } = params;

        // Mode: auto - allow everything
        if (this.config.approvalMode === 'auto') {
            this._auditLog({ ...params, status: 'allowed', approved_by: 'auto' });
            return { allowed: true };
        }

        // Check blocked commands
        const firstWord = command.split(/\s+/)[0];
        if (this.config.blockedCommands.includes(firstWord)) {
            this._auditLog({ ...params, status: 'blocked', reason: 'blocked_command' });
            return {
                allowed: false,
                reason: `Command '${firstWord}' is blocked`
            };
        }

        // Check if destructive
        const destructiveCheck = this.isDestructive(command);

        // Mode: review-destructive - queue only destructive commands
        if (this.config.approvalMode === 'review-destructive') {
            if (destructiveCheck.isDestructive) {
                const queueId = await this._queueCommand(params, destructiveCheck.matchedPattern);
                return {
                    allowed: false,
                    reason: 'Destructive command requires approval',
                    queueId,
                    queued: true
                };
            }

            this._auditLog({ ...params, status: 'allowed', approved_by: 'auto' });
            return { allowed: true };
        }

        // Mode: review-all - queue all commands
        if (this.config.approvalMode === 'review-all') {
            const queueId = await this._queueCommand(params, null);
            return {
                allowed: false,
                reason: 'All commands require approval',
                queueId,
                queued: true
            };
        }

        return { allowed: true };
    }

    /**
     * Queue a command for approval
     * @private
     */
    async _queueCommand(params, matchedPattern) {
        const queueId = crypto.randomUUID();
        const queueEntry = {
            id: queueId,
            command: params.command,
            sessionId: params.sessionId,
            source: params.source,
            type: params.type,
            matchedPattern,
            timestamp: Date.now(),
            status: 'pending',
            expiresAt: Date.now() + this.config.commandTimeout
        };

        this.commandQueue.set(queueId, queueEntry);
        this.emit('command-queued', queueEntry);
        this._auditLog({ ...params, status: 'pending', queueId });

        return queueId;
    }

    /**
     * Get pending commands in queue
     * @returns {Array} Pending commands
     */
    getPendingCommands() {
        const pending = [];
        const now = Date.now();

        for (const [id, entry] of this.commandQueue) {
            if (entry.status === 'pending') {
                if (entry.expiresAt < now) {
                    // Expired - deny automatically
                    entry.status = 'expired';
                    this.emit('command-expired', entry);
                } else {
                    pending.push(entry);
                }
            }
        }

        return pending;
    }

    /**
     * Approve a queued command
     * @param {string} queueId Queue entry ID
     * @param {string} approvedBy Who approved (user ID or 'dashboard')
     * @returns {Object} { success: boolean, command?: Object, error?: string }
     */
    approveCommand(queueId, approvedBy = 'dashboard') {
        const entry = this.commandQueue.get(queueId);
        if (!entry) {
            return { success: false, error: 'Command not found in queue' };
        }

        if (entry.status !== 'pending') {
            return { success: false, error: `Command already ${entry.status}` };
        }

        entry.status = 'approved';
        entry.approvedBy = approvedBy;
        entry.approvedAt = Date.now();

        this._auditLog({
            command: entry.command,
            sessionId: entry.sessionId,
            source: entry.source,
            type: entry.type,
            status: 'allowed',
            approved_by: approvedBy,
            queueId
        });

        this.emit('command-approved', entry);
        return { success: true, command: entry };
    }

    /**
     * Deny a queued command
     * @param {string} queueId Queue entry ID
     * @param {string} deniedBy Who denied
     * @param {string} reason Reason for denial
     * @returns {Object} { success: boolean, error?: string }
     */
    denyCommand(queueId, deniedBy = 'dashboard', reason = '') {
        const entry = this.commandQueue.get(queueId);
        if (!entry) {
            return { success: false, error: 'Command not found in queue' };
        }

        if (entry.status !== 'pending') {
            return { success: false, error: `Command already ${entry.status}` };
        }

        entry.status = 'denied';
        entry.deniedBy = deniedBy;
        entry.deniedAt = Date.now();
        entry.denyReason = reason;

        this._auditLog({
            command: entry.command,
            sessionId: entry.sessionId,
            source: entry.source,
            type: entry.type,
            status: 'blocked',
            blocked_by: deniedBy,
            reason,
            queueId
        });

        this.emit('command-denied', entry);
        return { success: true };
    }

    /**
     * Write to audit log
     * @private
     */
    _auditLog(entry) {
        if (!this.config.auditEnabled) return;

        const logEntry = {
            timestamp: new Date().toISOString(),
            session_id: entry.sessionId,
            source: entry.source || 'unknown',
            command_type: entry.type || 'unknown',
            command: entry.command,
            status: entry.status,
            approved_by: entry.approved_by,
            blocked_by: entry.blocked_by,
            reason: entry.reason,
            queue_id: entry.queueId,
            execution_result: entry.execution_result
        };

        try {
            fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
            fs.appendFileSync(this.auditPath, JSON.stringify(logEntry) + '\n');
        } catch (err) {
            console.error('[HappySafety] Failed to write audit log:', err.message);
        }
    }

    /**
     * Read audit log entries
     * @param {Object} options Query options
     * @param {number} options.limit Max entries to return
     * @param {string} options.sessionId Filter by session
     * @param {string} options.status Filter by status
     * @returns {Array} Audit entries
     */
    readAuditLog(options = {}) {
        const { limit = 100, sessionId, status } = options;

        try {
            if (!fs.existsSync(this.auditPath)) {
                return [];
            }

            const content = fs.readFileSync(this.auditPath, 'utf8');
            const lines = content.trim().split('\n').filter(l => l);

            let entries = lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            }).filter(e => e !== null);

            // Apply filters
            if (sessionId) {
                entries = entries.filter(e => e.session_id === sessionId);
            }
            if (status) {
                entries = entries.filter(e => e.status === status);
            }

            // Return most recent first, limited
            return entries.reverse().slice(0, limit);
        } catch (err) {
            console.error('[HappySafety] Failed to read audit log:', err.message);
            return [];
        }
    }

    /**
     * Clean up old audit entries
     * @returns {number} Entries removed
     */
    cleanupAuditLog() {
        const retentionMs = this.config.auditRetentionDays * 24 * 60 * 60 * 1000;
        const cutoff = new Date(Date.now() - retentionMs).toISOString();

        try {
            if (!fs.existsSync(this.auditPath)) return 0;

            const content = fs.readFileSync(this.auditPath, 'utf8');
            const lines = content.trim().split('\n').filter(l => l);

            const kept = lines.filter(line => {
                try {
                    const entry = JSON.parse(line);
                    return entry.timestamp >= cutoff;
                } catch {
                    return false;
                }
            });

            const removed = lines.length - kept.length;
            if (removed > 0) {
                fs.writeFileSync(this.auditPath, kept.join('\n') + '\n');
            }

            return removed;
        } catch (err) {
            console.error('[HappySafety] Failed to cleanup audit log:', err.message);
            return 0;
        }
    }

    /**
     * Get current configuration
     * @returns {Object} Current config
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Get safety status summary
     * @returns {Object} Status summary
     */
    getStatus() {
        const pending = this.getPendingCommands();
        const auditEntries = this.readAuditLog({ limit: 10 });

        return {
            approvalMode: this.config.approvalMode,
            pendingApprovals: pending.length,
            recentAuditEntries: auditEntries.length,
            auditEnabled: this.config.auditEnabled,
            blockedDirectoriesCount: this.config.blockedDirectories.length,
            allowedDirectoriesCount: this.config.allowedDirectories.length,
            destructivePatternsCount: this.config.destructivePatterns.length
        };
    }
}

// Singleton instance
let instance = null;

/**
 * Get or create the HappySafety singleton
 * @param {Object} options Configuration options
 * @returns {HappySafety}
 */
function getHappySafety(options = {}) {
    if (!instance) {
        instance = new HappySafety(options);
    }
    return instance;
}

module.exports = { HappySafety, getHappySafety };
