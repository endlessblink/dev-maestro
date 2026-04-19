const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const VPS_HOST = process.env.VPS_HOST || '84.46.253.137';
const VPS_USER = process.env.VPS_USER || 'root';
const VPS_SSH_KEY = process.env.VPS_SSH_KEY || path.join(process.env.HOME || '/root', '.ssh/id_ed25519');

// In-memory health history for sparkline (last 10 readings)
const healthHistory = [];
const MAX_HISTORY = 10;

// Load bots registry
function loadBots() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'bots.json'), 'utf8'));
    } catch (e) {
        console.error('[VPS] Failed to load bots.json:', e.message);
        return [];
    }
}

// SSH args helper — uses ControlMaster for connection reuse (~50ms after first connect)
function sshArgs(command) {
    return [
        '-i', VPS_SSH_KEY,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPath=/tmp/watchpost-vps-%r@%h:%p',
        '-o', 'ControlPersist=300',
        '-o', 'ConnectTimeout=8',
        '-o', 'BatchMode=yes',
        `${VPS_USER}@${VPS_HOST}`,
        command
    ];
}

// Run SSH command, pipe script via stdin if scriptContent provided
function sshRun(command, scriptContent, timeoutMs) {
    return new Promise((resolve, reject) => {
        const args = sshArgs(command);
        const proc = spawn('ssh', args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);

        if (scriptContent) {
            proc.stdin.write(scriptContent);
            proc.stdin.end();
        }

        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error('SSH timeout'));
        }, timeoutMs || 12000);

        proc.on('close', code => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code });
        });
        proc.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

// HTTP/HTTPS ping — returns { ok, code, latencyMs }
function httpPing(url, timeoutMs) {
    return new Promise(resolve => {
        if (!url) return resolve({ ok: false, code: null });
        const start = Date.now();
        const mod = url.startsWith('https') ? https : http;
        try {
            const req = mod.get(url, { timeout: timeoutMs || 4000 }, res => {
                res.resume();
                resolve({ ok: res.statusCode < 500, code: res.statusCode, latencyMs: Date.now() - start });
            });
            req.on('error', () => resolve({ ok: false, code: null }));
            req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 'timeout' }); });
        } catch (e) {
            resolve({ ok: false, code: null });
        }
    });
}

// Build discovery script — line-format output:
//   DOCKER|<name>|<state>       — one per running container
//   SYSTEMD|<botId>|<state>     — for bots with systemdService
//   SYSTEMD2|<botId>|<state>    — secondary systemd service
//   STATICDIR|<botId>|yes/no    — for bots with staticDir
//   RESOURCES|{...json...}      — system metrics
function buildDiscoveryScript(bots) {
    const lines = [];

    // Auto-discover ALL Docker containers (running or not)
    lines.push(`docker ps -a --format 'DOCKER|{{.Names}}|{{.State}}' 2>/dev/null`);

    // Explicit systemd/staticdir checks for bots that need them
    for (const bot of bots) {
        const safeId = bot.id.replace(/[^a-zA-Z0-9_-]/g, '');
        if (bot.systemdService) {
            lines.push(`printf 'SYSTEMD|${safeId}|%s\\n' "$(systemctl is-active ${bot.systemdService} 2>/dev/null || echo inactive)"`);
        }
        if (bot.systemdServiceSecondary) {
            lines.push(`printf 'SYSTEMD2|${safeId}|%s\\n' "$(systemctl is-active ${bot.systemdServiceSecondary} 2>/dev/null || echo inactive)"`);
        }
        if (bot.staticDir) {
            lines.push(`[ -d ${bot.staticDir} ] && printf 'STATICDIR|${safeId}|yes\\n' || printf 'STATICDIR|${safeId}|no\\n'`);
        }
    }

    // Resources (single JSON line prefixed with RESOURCES|)
    lines.push(`CPU=$(top -bn1 | grep -E "^%?Cpu" | awk '{print $2+$4}' | cut -d. -f1 2>/dev/null || echo "0")`);
    lines.push(`RAM_USED=$(free -m | awk 'NR==2{print $3}')`);
    lines.push(`RAM_TOTAL=$(free -m | awk 'NR==2{print $2}')`);
    lines.push(`DISK_USED=$(df / | awk 'NR==2{print $5}' | tr -d '%')`);
    lines.push(`DISK_TOTAL=$(df -h / | awk 'NR==2{print $2}')`);
    lines.push(`UPTIME=$(uptime -p 2>/dev/null || echo "unknown")`);
    lines.push(`LOAD=$(cat /proc/loadavg | awk '{print $1,$2,$3}')`);
    lines.push(`printf 'RESOURCES|{"cpu":%s,"ramUsed":%s,"ramTotal":%s,"diskPct":%s,"diskTotal":"%s","uptime":"%s","load":"%s"}\\n' "\${CPU:-0}" "\${RAM_USED:-0}" "\${RAM_TOTAL:-1}" "\${DISK_USED:-0}" "\${DISK_TOTAL:-?}" "$UPTIME" "$LOAD"`);

    return lines.join('\n');
}

// Parse discovery script output into structured maps
function parseDiscovery(stdout) {
    const docker = {};    // containerName -> state
    const systemd = {};   // botId -> state
    const systemd2 = {};  // botId -> secondary state
    const staticdir = {}; // botId -> 'yes'/'no'
    let resources = {};

    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const firstPipe = trimmed.indexOf('|');
        if (firstPipe === -1) continue;
        const type = trimmed.slice(0, firstPipe);
        const rest = trimmed.slice(firstPipe + 1);
        const secondPipe = rest.indexOf('|');
        const key = secondPipe === -1 ? rest : rest.slice(0, secondPipe);
        const val = secondPipe === -1 ? '' : rest.slice(secondPipe + 1);

        if (type === 'DOCKER')         docker[key] = val;
        else if (type === 'SYSTEMD')   systemd[key] = val;
        else if (type === 'SYSTEMD2')  systemd2[key] = val;
        else if (type === 'STATICDIR') staticdir[key] = val;
        else if (type === 'RESOURCES') {
            try { resources = JSON.parse(rest); } catch (e) {}
        }
    }
    return { docker, systemd, systemd2, staticdir, resources };
}

// Compute display status for a bots.json-registered service
function computeStatus(bot, discovery, ping) {
    const { docker, systemd, systemd2, staticdir } = discovery;
    let running = false;

    if (bot.dockerContainer) {
        running = docker[bot.dockerContainer] === 'running';
        if (bot.dockerContainerSecondary) {
            running = running && docker[bot.dockerContainerSecondary] === 'running';
        }
    } else if (bot.systemdService) {
        running = systemd[bot.id] === 'active';
        if (bot.systemdServiceSecondary) {
            running = running && systemd2[bot.id] === 'active';
        }
    } else if (bot.staticDir) {
        running = staticdir[bot.id] === 'yes';
    }

    if (!running) return { status: 'red', detail: getDetail(bot, discovery) };
    if (bot.httpPingUrl && !ping.ok) return { status: 'amber', detail: 'Running but not responding' };
    return { status: 'green', detail: getDetail(bot, discovery) };
}

function getDetail(bot, discovery) {
    const { docker, systemd, systemd2, staticdir } = discovery;
    if (bot.dockerContainer && bot.dockerContainerSecondary) {
        return `Main: ${docker[bot.dockerContainer] || '?'} / Gateway: ${docker[bot.dockerContainerSecondary] || '?'}`;
    }
    if (bot.dockerContainer) return docker[bot.dockerContainer] || 'unknown';
    if (bot.systemdService && bot.systemdServiceSecondary) {
        return `Bot: ${systemd[bot.id] || '?'} / Dashboard: ${systemd2[bot.id] || '?'}`;
    }
    if (bot.systemdService) return systemd[bot.id] || 'unknown';
    if (bot.staticDir) return staticdir[bot.id] === 'yes' ? 'Files present' : 'Directory missing';
    return '';
}

// Generate a deterministic gradient for auto-discovered containers
function autoGradient(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    const hue = Math.abs(hash) % 360;
    return {
        gradientFrom: `hsl(${hue}, 55%, 7%)`,
        gradientTo: `hsl(${hue}, 65%, 30%)`
    };
}

module.exports = function(app) {

    // GET /api/vps/bots — return registry (no SSH needed)
    app.get('/api/vps/bots', (req, res) => {
        res.json(loadBots());
    });

    // GET /api/vps/cover/:id — serve cover (proxies project cover if projectAlias set, else VPS-specific file)
    app.get('/api/vps/cover/:id', (req, res) => {
        const bots = loadBots();
        const bot = bots.find(b => b.id === req.params.id);
        if (!bot) return res.status(404).end();

        if (bot.projectAlias) {
            return res.redirect(`/api/projects/${encodeURIComponent(bot.projectAlias)}/cover`);
        }

        const coversDir = path.join(process.env.HOME || '/root', '.watchpost/data/covers');
        for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
            const coverPath = path.join(coversDir, `vps-${bot.id}.${ext}`);
            if (fs.existsSync(coverPath)) return res.sendFile(coverPath);
        }

        res.status(404).end();
    });

    // GET /api/vps/status — live discovery via SSH + HTTP pings
    app.get('/api/vps/status', async (req, res) => {
        const bots = loadBots();
        const timestamp = new Date().toISOString();

        let sshResult;
        try {
            sshResult = await sshRun('bash -s', buildDiscoveryScript(bots), 15000);
        } catch (err) {
            return res.json({
                error: err.message.includes('timeout') ? 'timeout' : 'ssh_failed',
                message: err.message.slice(0, 200),
                timestamp
            });
        }

        const discovery = parseDiscovery(sshResult.stdout);

        // Parallel HTTP pings for bots with a pingUrl
        const pings = {};
        await Promise.all(
            bots
                .filter(b => b.httpPingUrl)
                .map(async b => { pings[b.id] = await httpPing(b.httpPingUrl, 4000); })
        );

        // Track which Docker containers are claimed by bots.json entries
        const claimedContainers = new Set(
            bots.flatMap(b => [b.dockerContainer, b.dockerContainerSecondary].filter(Boolean))
        );

        // Registered services (from bots.json — enriched with name/description/cover/dashboard)
        const registeredServices = bots.map(bot => {
            const { status, detail } = computeStatus(bot, discovery, pings[bot.id] || { ok: true });
            return {
                id: bot.id,
                name: bot.name,
                description: bot.description,
                category: bot.category || 'other',
                status,
                detail,
                dashboardUrl: bot.dashboardUrl,
                dashboardLabel: bot.dashboardLabel,
                canRestart: bot.canRestart,
                icon: bot.icon,
                gradientFrom: bot.gradientFrom,
                gradientTo: bot.gradientTo,
                projectAlias: bot.projectAlias
            };
        });

        // Auto-discovered Docker containers NOT in bots.json
        const autoServices = Object.entries(discovery.docker)
            .filter(([name]) => !claimedContainers.has(name))
            .map(([name, state]) => {
                const { gradientFrom, gradientTo } = autoGradient(name);
                return {
                    id: name,
                    name: name,
                    description: 'Docker container',
                    category: 'containers',
                    status: state === 'running' ? 'green' : 'red',
                    detail: state,
                    dashboardUrl: null,
                    dashboardLabel: null,
                    canRestart: true,
                    icon: 'box',
                    gradientFrom,
                    gradientTo,
                    autoDiscovered: true
                };
            });

        res.json({
            services: [...registeredServices, ...autoServices],
            resources: discovery.resources,
            timestamp
        });
    });

    // GET /api/vps/health — system metrics for Health sub-tab
    app.get('/api/vps/health', async (req, res) => {
        const timestamp = new Date().toISOString();
        const healthScript = `
CPU=$(top -bn1 | grep -E "^%?Cpu" | awk '{print $2+$4}' | cut -d. -f1 2>/dev/null || echo "0")
RAM_USED=$(free -m | awk 'NR==2{print $3}')
RAM_TOTAL=$(free -m | awk 'NR==2{print $2}')
RAM_PCT=$(free | awk 'NR==2{printf "%.0f", $3/$2*100}')
DISK_USED=$(df / | awk 'NR==2{print $5}' | tr -d '%')
DISK_TOTAL=$(df -h / | awk 'NR==2{print $2}')
UPTIME=$(uptime -p 2>/dev/null || echo "unknown")
LOAD1=$(cat /proc/loadavg | awk '{print $1}')
LOAD5=$(cat /proc/loadavg | awk '{print $2}')
LOAD15=$(cat /proc/loadavg | awk '{print $3}')
NET_RX=$(cat /proc/net/dev | awk 'NR>2{rx+=$2} END{print rx}' 2>/dev/null || echo "0")
NET_TX=$(cat /proc/net/dev | awk 'NR>2{tx+=$10} END{print tx}' 2>/dev/null || echo "0")
TOP_CPU=$(ps aux --sort=-%cpu | awk 'NR>1 && NR<=6{printf "%s %.1f\\n",$11,$3}' | sed 's|.*/||')
TOP_RAM=$(ps aux --sort=-%mem | awk 'NR>1 && NR<=6{printf "%s %.0f\\n",$11,($6/1024)}' | sed 's|.*/||')
printf '{"cpu":%s,"ram":{"used":%s,"total":%s,"pct":%s},"disk":{"pct":%s,"total":"%s"},"uptime":"%s","load":{"1m":"%s","5m":"%s","15m":"%s"},"network":{"rxBytes":%s,"txBytes":%s},"topCpu":"%s","topRam":"%s"}' \
  "\${CPU:-0}" "\${RAM_USED:-0}" "\${RAM_TOTAL:-1}" "\${RAM_PCT:-0}" \
  "\${DISK_USED:-0}" "\${DISK_TOTAL:-?}" \
  "$UPTIME" "$LOAD1" "$LOAD5" "$LOAD15" \
  "\${NET_RX:-0}" "\${NET_TX:-0}" \
  "$(echo "$TOP_CPU" | head -5 | tr '\\n' '|')" \
  "$(echo "$TOP_RAM" | head -5 | tr '\\n' '|')"
`;

        let result;
        try {
            result = await sshRun('bash -s', healthScript, 12000);
        } catch (err) {
            return res.json({ error: err.message.includes('timeout') ? 'timeout' : 'ssh_failed', timestamp });
        }

        let data;
        try {
            data = JSON.parse(result.stdout.trim());
        } catch (e) {
            return res.json({ error: 'parse_failed', raw: result.stdout.slice(0, 500), timestamp });
        }

        data.topCpu = (data.topCpu || '').split('|').filter(Boolean).map(s => {
            const parts = s.trim().split(' ');
            return { name: parts[0], value: parts[1] + '%' };
        });
        data.topRam = (data.topRam || '').split('|').filter(Boolean).map(s => {
            const parts = s.trim().split(' ');
            return { name: parts[0], value: parts[1] + ' MB' };
        });

        healthHistory.push({ cpu: data.cpu, ts: timestamp });
        if (healthHistory.length > MAX_HISTORY) healthHistory.shift();
        data.history = healthHistory.map(h => h.cpu);
        data.timestamp = timestamp;

        res.json(data);
    });

    // GET /api/vps/logs/:service — last 20 lines
    // Works for both bots.json entries (uses logsCommand) and auto-discovered containers (uses docker logs)
    app.get('/api/vps/logs/:service', async (req, res) => {
        const bots = loadBots();
        const serviceId = req.params.service;
        const bot = bots.find(b => b.id === serviceId);

        let logsCommand;
        if (bot && bot.logsCommand) {
            logsCommand = bot.logsCommand;
        } else if (!bot) {
            // Auto-discovered Docker container — safe because we only allow [a-zA-Z0-9_-]
            if (!/^[a-zA-Z0-9_-]+$/.test(serviceId)) {
                return res.status(400).json({ error: 'Invalid service id' });
            }
            logsCommand = `docker logs --tail=20 ${serviceId} 2>&1`;
        } else {
            return res.status(400).json({ error: 'No logs available for this service' });
        }

        try {
            const result = await sshRun(logsCommand, null, 8000);
            const lines = (result.stdout + result.stderr).split('\n').filter(Boolean);
            res.json({ service: serviceId, lines, timestamp: new Date().toISOString() });
        } catch (err) {
            res.json({ service: serviceId, error: err.message, lines: [] });
        }
    });

    // POST /api/vps/restart/:service
    // Works for bots.json entries (uses restartCommand) and auto-discovered containers (uses docker restart)
    app.post('/api/vps/restart/:service', async (req, res) => {
        const bots = loadBots();
        const serviceId = req.params.service;
        const bot = bots.find(b => b.id === serviceId);

        let restartCommand;
        if (bot) {
            if (!bot.restartCommand) return res.status(400).json({ error: 'This service cannot be restarted' });
            restartCommand = bot.restartCommand;
        } else {
            // Auto-discovered Docker container
            if (!/^[a-zA-Z0-9_-]+$/.test(serviceId)) {
                return res.status(400).json({ error: 'Invalid service id' });
            }
            restartCommand = `docker restart ${serviceId}`;
        }

        try {
            const result = await sshRun(restartCommand, null, 30000);
            res.json({ ok: true, service: serviceId, output: (result.stdout + result.stderr).slice(0, 500) });
        } catch (err) {
            res.json({ ok: false, service: serviceId, error: err.message.slice(0, 300) });
        }
    });
};
