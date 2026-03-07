/**
 * Happy Manager Module
 *
 * Manages Happy Coder CLI sessions for remote Claude Code control.
 * Spawns happy processes, tracks active sessions, and emits events.
 *
 * @module happy-manager
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class HappyManager extends EventEmitter {
    constructor(options = {}) {
        super();

        // Configuration
        this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
        this.sessionsFile = path.join(this.dataDir, 'happy-sessions.json');
        this.happyBinary = options.happyBinary || 'happy';

        // Active sessions map: sessionId -> sessionData
        this.sessions = new Map();

        // Load persisted sessions (for recovery)
        this._loadSessions();
    }

    /**
     * Check if Happy CLI is installed
     * @returns {Object} { installed: boolean, version?: string, error?: string }
     */
    async checkInstallation() {
        return new Promise((resolve) => {
            const proc = spawn(this.happyBinary, ['--version'], {
                shell: true,
                timeout: 5000
            });

            let output = '';
            proc.stdout.on('data', (data) => {
                output += data.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    const version = output.trim().match(/\d+\.\d+\.\d+/)?.[0] || 'unknown';
                    resolve({ installed: true, version });
                } else {
                    resolve({
                        installed: false,
                        error: 'Happy CLI not found. Install with: npm install -g happy-coder'
                    });
                }
            });

            proc.on('error', (err) => {
                resolve({
                    installed: false,
                    error: `Happy CLI error: ${err.message}`
                });
            });
        });
    }

    /**
     * Start a new Happy session
     * @param {Object} options Session configuration
     * @param {string} options.projectPath Working directory for Claude Code
     * @param {string} options.model Claude model to use (default: sonnet)
     * @param {string} options.permissionMode Permission mode (auto, default, plan)
     * @param {Object} options.env Additional environment variables
     * @returns {Object} Session info { id, status, qrCode?, error? }
     */
    async startSession(options = {}) {
        const sessionId = crypto.randomUUID();
        const {
            projectPath = process.cwd(),
            model = 'sonnet',
            permissionMode = 'default',
            env = {}
        } = options;

        // Build Happy CLI arguments
        const args = [];
        if (model) args.push('-m', model);
        if (permissionMode) args.push('-p', permissionMode);

        // Session data
        const session = {
            id: sessionId,
            status: 'starting',
            projectPath,
            model,
            permissionMode,
            startedAt: new Date().toISOString(),
            process: null,
            qrCode: null,
            qrData: null,
            output: [],
            lastActivity: Date.now()
        };

        // Spawn Happy process
        try {
            const proc = spawn(this.happyBinary, args, {
                cwd: projectPath,
                shell: true,
                env: { ...process.env, ...env },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            session.process = proc;
            session.pid = proc.pid;

            // Buffer for output parsing
            let outputBuffer = '';
            let qrBuffer = '';
            let qrCapturing = false;

            // Handle stdout - parse for QR code and status
            proc.stdout.on('data', (data) => {
                const chunk = data.toString();
                outputBuffer += chunk;
                session.output.push({ type: 'stdout', data: chunk, ts: Date.now() });
                session.lastActivity = Date.now();

                // Emit raw output for streaming
                this.emit('session-output', { sessionId, type: 'stdout', data: chunk });

                // Parse for QR code (Happy displays QR in terminal)
                if (chunk.includes('█') || chunk.includes('▀') || chunk.includes('▄')) {
                    qrCapturing = true;
                    qrBuffer += chunk;
                }

                // Detect session connected
                if (chunk.includes('connected') || chunk.includes('paired')) {
                    session.status = 'connected';
                    this.emit('session-connected', { sessionId });
                    this._saveSessions();
                }

                // Detect QR code URL (Happy shows pairing URL)
                const urlMatch = chunk.match(/https?:\/\/[^\s]+happy[^\s]*/i);
                if (urlMatch) {
                    session.qrData = urlMatch[0];
                    session.status = 'awaiting-pairing';
                    this.emit('session-qr-ready', { sessionId, url: session.qrData });
                    this._saveSessions();
                }
            });

            // Handle stderr
            proc.stderr.on('data', (data) => {
                const chunk = data.toString();
                session.output.push({ type: 'stderr', data: chunk, ts: Date.now() });
                session.lastActivity = Date.now();
                this.emit('session-output', { sessionId, type: 'stderr', data: chunk });

                // Check for errors
                if (chunk.includes('error') || chunk.includes('Error')) {
                    this.emit('session-error', { sessionId, error: chunk });
                }
            });

            // Handle process exit
            proc.on('close', (code) => {
                session.status = 'stopped';
                session.exitCode = code;
                session.stoppedAt = new Date().toISOString();
                this.emit('session-stopped', { sessionId, exitCode: code });
                this._saveSessions();
            });

            proc.on('error', (err) => {
                session.status = 'error';
                session.error = err.message;
                this.emit('session-error', { sessionId, error: err.message });
                this._saveSessions();
            });

            // Store session
            this.sessions.set(sessionId, session);
            session.status = 'running';
            this._saveSessions();

            this.emit('session-started', { sessionId, projectPath, model });

            return {
                id: sessionId,
                status: session.status,
                pid: proc.pid,
                projectPath,
                model
            };

        } catch (err) {
            return {
                id: sessionId,
                status: 'error',
                error: err.message
            };
        }
    }

    /**
     * Stop a Happy session
     * @param {string} sessionId Session ID to stop
     * @param {boolean} force Kill forcefully (SIGKILL vs SIGTERM)
     * @returns {Object} { success: boolean, error?: string }
     */
    stopSession(sessionId, force = false) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { success: false, error: 'Session not found' };
        }

        if (!session.process || session.status === 'stopped') {
            return { success: false, error: 'Session already stopped' };
        }

        try {
            const signal = force ? 'SIGKILL' : 'SIGTERM';
            session.process.kill(signal);
            session.status = 'stopping';
            this._saveSessions();

            return { success: true, signal };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Get all active sessions
     * @returns {Array} Array of session info objects
     */
    getSessions() {
        const sessions = [];
        for (const [id, session] of this.sessions) {
            sessions.push({
                id,
                status: session.status,
                projectPath: session.projectPath,
                model: session.model,
                startedAt: session.startedAt,
                stoppedAt: session.stoppedAt,
                pid: session.pid,
                qrData: session.qrData,
                lastActivity: session.lastActivity
            });
        }
        return sessions;
    }

    /**
     * Get a specific session
     * @param {string} sessionId Session ID
     * @returns {Object|null} Session info or null
     */
    getSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        return {
            id: sessionId,
            status: session.status,
            projectPath: session.projectPath,
            model: session.model,
            startedAt: session.startedAt,
            stoppedAt: session.stoppedAt,
            pid: session.pid,
            qrData: session.qrData,
            lastActivity: session.lastActivity,
            outputLength: session.output.length
        };
    }

    /**
     * Get session output (last N lines)
     * @param {string} sessionId Session ID
     * @param {number} lines Number of lines to return
     * @returns {Array} Output lines
     */
    getSessionOutput(sessionId, lines = 100) {
        const session = this.sessions.get(sessionId);
        if (!session) return [];

        return session.output.slice(-lines);
    }

    /**
     * Send input to a session
     * @param {string} sessionId Session ID
     * @param {string} input Text to send
     * @returns {Object} { success: boolean, error?: string }
     */
    sendInput(sessionId, input) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.process) {
            return { success: false, error: 'Session not found or not running' };
        }

        try {
            session.process.stdin.write(input);
            session.lastActivity = Date.now();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Clean up stopped sessions older than specified hours
     * @param {number} olderThanHours Clean sessions older than this
     * @returns {number} Number of sessions cleaned
     */
    cleanupOldSessions(olderThanHours = 24) {
        const cutoff = Date.now() - (olderThanHours * 60 * 60 * 1000);
        let cleaned = 0;

        for (const [id, session] of this.sessions) {
            if (session.status === 'stopped' && session.lastActivity < cutoff) {
                this.sessions.delete(id);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this._saveSessions();
        }

        return cleaned;
    }

    /**
     * Save sessions to disk
     * @private
     */
    _saveSessions() {
        try {
            const data = [];
            for (const [id, session] of this.sessions) {
                // Don't persist the process object
                const { process, ...sessionData } = session;
                data.push({ id, ...sessionData });
            }

            fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
            fs.writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('[HappyManager] Failed to save sessions:', err.message);
        }
    }

    /**
     * Load sessions from disk
     * @private
     */
    _loadSessions() {
        try {
            if (fs.existsSync(this.sessionsFile)) {
                const data = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
                for (const session of data) {
                    // Mark old running sessions as orphaned
                    if (session.status === 'running' || session.status === 'connected') {
                        session.status = 'orphaned';
                    }
                    this.sessions.set(session.id, session);
                }
            }
        } catch (err) {
            console.error('[HappyManager] Failed to load sessions:', err.message);
        }
    }
}

// Singleton instance
let instance = null;

/**
 * Get or create the HappyManager singleton
 * @param {Object} options Configuration options
 * @returns {HappyManager}
 */
function getHappyManager(options = {}) {
    if (!instance) {
        instance = new HappyManager(options);
    }
    return instance;
}

module.exports = { HappyManager, getHappyManager };
