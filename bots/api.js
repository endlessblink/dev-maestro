// Bots & Personas catalog.
//
// Answers "what bots do I have, what persona is each one, where does its code
// live, and is it running" by merging four live sources — never a hand-written
// doc, which is what went stale before this existed:
//
//   1. per-repo manifests   <project>/.watchpost/bot.json   (auto-discovered)
//   2. VPS runtime          shared snapshot from vps/api.js
//   3. live persona config  read off the running bot's own config over SSH
//   4. git activity         cached helper from controlroom/api.js
//
// It also renders itself as markdown for AI agents (see /api/bots/index.md), so
// asking any assistant about "diet bot" resolves without grepping repos.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const vpsHelpers = require('../vps/api').helpers;
const controlRoomHelpers = require('../controlroom/api').helpers;

const { sshRun, loadBots, computeStatus, getDiscoverySnapshot } = vpsHelpers;
const { getGitInfo, loadProjects } = controlRoomHelpers;

const MANIFEST_RELATIVE_PATH = path.join('.watchpost', 'bot.json');
const PERSONA_CACHE_TTL_MS = 60000;
const CATALOG_CACHE_TTL_MS = 20000;

// Generated agent-facing index. Regenerated from live data — never hand-edited.
const AGENT_INDEX_PATH = path.join(os.homedir(), '.claude', 'knowledge', 'bot-fleet.md');

let personaCache = null;   // { at, value }
let catalogCache = null;   // { at, value }

// ─── Manifest discovery ───────────────────────────────────────────────────────

function normalizeManifest(raw, project) {
    if (!raw || typeof raw !== 'object') return null;

    const deployment = raw.deployment || {};
    return {
        id: raw.id || project.name,
        name: raw.name || raw.id || project.name,
        aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
        platform: raw.platform || 'unknown',
        lifecycle: raw.lifecycle || 'active',
        summary: raw.summary || raw.description || '',
        deployment: {
            kind: deployment.kind || 'local',
            vpsBotId: deployment.vpsBotId || null,
            container: deployment.container || null,
            service: deployment.service || null,
            host: deployment.host || null
        },
        chats: Array.isArray(raw.chats) ? raw.chats : [],
        personaSource: raw.personaSource || null,
        personas: Array.isArray(raw.personas) ? raw.personas : [],
        docs: Array.isArray(raw.docs) ? raw.docs : [],
        notes: raw.notes || '',
        projectName: project.name,
        projectRoot: project.root
    };
}

// Extra roots to scan beyond projects.json, from local/config.json →
// "botManifestRoots". Needed for repos that live outside the scanned tree (the
// canonical Hermes checkout under ~/.hermes, for example). local/ is gitignored
// and preserved across updates, which is why the override lives there.
function extraManifestRoots() {
    try {
        const configPath = path.join(__dirname, '..', 'local', 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!Array.isArray(config.botManifestRoots)) return [];
        return config.botManifestRoots
            .filter(root => typeof root === 'string' && root)
            .map(root => ({ name: path.basename(root), root }));
    } catch {
        return [];
    }
}

// Walk projects.json (plus any extra roots) and pick up every repo carrying a
// bot manifest. New bots appear the moment they add the file — no edit to
// Watchpost required.
function discoverManifests() {
    const manifests = [];
    const scanned = new Set();

    for (const project of [...loadProjects(), ...extraManifestRoots()]) {
        if (!project || !project.root) continue;
        if (scanned.has(project.root)) continue;
        scanned.add(project.root);
        const manifestPath = path.join(project.root, MANIFEST_RELATIVE_PATH);

        let parsed;
        try {
            if (!fs.existsSync(manifestPath)) continue;
            parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (err) {
            manifests.push({
                id: `${project.name}-invalid`,
                name: project.name,
                aliases: [],
                platform: 'unknown',
                lifecycle: 'unknown',
                deployment: { kind: 'local' },
                chats: [],
                personas: [],
                docs: [],
                projectName: project.name,
                projectRoot: project.root,
                manifestError: err.message.slice(0, 200)
            });
            continue;
        }

        // A repo may host more than one bot (array form).
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
            const normalized = normalizeManifest(entry, project);
            if (normalized) manifests.push(normalized);
        }
    }

    return manifests;
}

// ─── Live persona probe ───────────────────────────────────────────────────────

// Reads persona maps off the running bots' own config files, on the VPS, in one
// SSH round-trip. Python is used for parsing because the VPS host already has
// PyYAML and Watchpost deliberately carries no YAML dependency.
function buildPersonaProbe(sources) {
    // The spec list is embedded rather than piped: ssh stdin already carries the
    // script itself, so there is no second channel to send it on.
    return `
import json
SPECS = json.loads(${JSON.stringify(JSON.stringify(sources))})

def hermes(path):
    import yaml
    with open(path) as fh:
        cfg = yaml.safe_load(fh) or {}
    tg = cfg.get('telegram') or {}
    platforms_tg = ((cfg.get('platforms') or {}).get('telegram') or {})

    # The key holding topic personas has moved between Hermes versions, so read
    # both and report whichever is actually populated.
    candidates = [
        ('telegram.channel_prompts', tg.get('channel_prompts') or {}),
        ('platforms.telegram.channel_overrides', platforms_tg.get('channel_overrides') or {}),
    ]
    key, prompts = next(((k, v) for k, v in candidates if v), (None, {}))

    return {
        'kind': 'hermes-config',
        'sourceKey': key,
        'prompts': {str(k): str(v) for k, v in prompts.items()},
        'allowedChats': [str(c) for c in (tg.get('allowed_chats') or [])],
        'allowedTopics': [str(t) for t in (tg.get('allowed_topics') or [])],
        'configVersion': cfg.get('_config_version'),
    }

def cnc_state(path):
    with open(path) as fh:
        state = json.load(fh) or {}
    return {
        'kind': 'cnc-state',
        'sourceKey': 'state.chatPersonas',
        'prompts': {str(k): str(v) for k, v in (state.get('chatPersonas') or {}).items()},
        'chatTitles': state.get('chatTitles') or {},
    }

READERS = {'hermes-config': hermes, 'cnc-state': cnc_state}

out = {}
for spec in SPECS:
    key = spec['kind'] + '::' + spec['path']
    try:
        out[key] = READERS[spec['kind']](spec['path'])
    except Exception as exc:
        out[key] = {'kind': spec['kind'], 'error': str(exc)[:200]}

print(json.dumps(out))
`;
}

function personaSourceKey(source) {
    return `${source.kind}::${source.path}`;
}

async function probePersonas(manifests, force) {
    const now = Date.now();
    if (!force && personaCache && now - personaCache.at < PERSONA_CACHE_TTL_MS) {
        return personaCache.value;
    }

    // De-duplicate: several manifests may point at the same config file.
    const sources = [];
    const seen = new Set();
    for (const manifest of manifests) {
        const source = manifest.personaSource;
        if (!source || !source.kind || !source.path) continue;
        const key = personaSourceKey(source);
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({ kind: source.kind, path: source.path });
    }

    if (sources.length === 0) {
        const empty = { sources: {}, error: null };
        personaCache = { at: now, value: empty };
        return empty;
    }

    let value;
    try {
        const result = await sshRun('python3 -', buildPersonaProbe(sources), 25000);
        // The probe prints exactly one JSON object as its final line; anything
        // before it is login noise from the remote shell.
        const lastLine = (result.stdout || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .pop();

        if (!lastLine || !lastLine.startsWith('{')) {
            throw new Error((result.stderr || 'probe produced no JSON').trim().split('\n').pop());
        }
        value = { sources: JSON.parse(lastLine), error: null };
    } catch (err) {
        value = { sources: {}, error: err.message.slice(0, 200) };
    }

    personaCache = { at: Date.now(), value };
    return value;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

// Persona keys are '<chatId>:<topicId>'. Pull a readable name out of the prompt
// text — the personas name themselves in their first clause, e.g.
// "🍓 Diet Bot (topic 306). This topic owns food…".
function personaNameFromPrompt(prompt) {
    if (!prompt) return null;
    const firstClause = String(prompt).split(/[.(\n]/)[0].trim();
    const cleaned = firstClause.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    return cleaned ? cleaned.slice(0, 60) : null;
}

function livePersonasFor(manifest, personaProbe) {
    if (!manifest.personaSource) return { entries: [], sourceKey: null, error: null };

    const source = personaProbe.sources[personaSourceKey(manifest.personaSource)];
    if (!source) return { entries: [], sourceKey: null, error: personaProbe.error };
    if (source.error) return { entries: [], sourceKey: null, error: source.error };

    const entries = Object.entries(source.prompts || {}).map(([key, prompt]) => {
        const [chatId, topicId] = key.includes(':') ? key.split(':') : [key, null];
        return {
            key,
            chatId,
            topicId,
            name: personaNameFromPrompt(prompt) || key,
            prompt,
            allowed: !source.allowedTopics || !topicId || source.allowedTopics.includes(String(topicId))
        };
    });

    return {
        entries,
        sourceKey: source.sourceKey,
        configVersion: source.configVersion || null,
        allowedChats: source.allowedChats || [],
        allowedTopics: source.allowedTopics || [],
        error: null
    };
}

// Not every bot lives on the VPS — some run in Docker on this workstation.
// One `docker ps` per catalog build covers them all.
function localDockerState() {
    try {
        const raw = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}|{{.State}}'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000
        });
        const states = {};
        for (const line of raw.split('\n').filter(Boolean)) {
            const [name, state] = line.split('|');
            if (name) states[name] = state;
        }
        return { ok: true, states };
    } catch {
        return { ok: false, states: {} };
    }
}

function resolveRuntime(manifest, snapshot, localDocker) {
    const { discovery, pings, sshOk } = snapshot;
    const registry = loadBots();
    const deployment = manifest.deployment || {};

    if (deployment.kind === 'local-docker') {
        if (!localDocker.ok) return { status: 'unknown', detail: 'Local Docker not reachable' };
        const state = localDocker.states[deployment.container];
        if (!state) return { status: 'red', detail: 'Local container not found' };
        return { status: state === 'running' ? 'green' : 'red', detail: `local docker: ${state}` };
    }

    if (deployment.kind === 'local' || deployment.kind === 'none') {
        return { status: 'local', detail: 'Runs locally / not deployed' };
    }

    // Prefer the existing bots.json entry — it knows about secondary containers,
    // systemd pairs and health-ping URLs.
    const registryEntry = deployment.vpsBotId
        ? registry.find(b => b.id === deployment.vpsBotId)
        : null;

    if (registryEntry) {
        return computeStatus(registryEntry, discovery, pings[registryEntry.id] || { ok: true }, sshOk);
    }

    if (!sshOk) return { status: 'unknown', detail: 'SSH unavailable' };

    if (deployment.container) {
        const state = discovery.docker[deployment.container];
        if (!state) return { status: 'red', detail: 'Container not found' };
        return { status: state === 'running' ? 'green' : 'red', detail: state };
    }

    return { status: 'unknown', detail: 'No deployment target declared' };
}

function computeDrift(manifest, live, runtime) {
    const drift = [];

    if (manifest.manifestError) {
        drift.push({ level: 'error', message: `Manifest is not valid JSON: ${manifest.manifestError}` });
        return drift;
    }

    if (manifest.personaSource && live.error) {
        drift.push({ level: 'warn', message: `Could not read live personas: ${live.error}` });
    }

    if (manifest.personaSource && !live.error && live.entries.length > 0) {
        const liveTopics = new Set(live.entries.map(e => String(e.topicId)));
        const declaredTopics = new Set(manifest.personas.map(p => String(p.topicId)));

        for (const topic of declaredTopics) {
            if (!liveTopics.has(topic)) {
                drift.push({ level: 'error', message: `Declared persona on topic ${topic} is not in the live config` });
            }
        }
        for (const topic of liveTopics) {
            if (declaredTopics.size > 0 && !declaredTopics.has(topic)) {
                drift.push({ level: 'warn', message: `Live persona on topic ${topic} is not declared in the manifest` });
            }
        }
        for (const entry of live.entries) {
            if (!entry.allowed) {
                drift.push({ level: 'warn', message: `Persona "${entry.name}" is configured but topic ${entry.topicId} is not allow-listed` });
            }
        }
    }

    if (manifest.lifecycle === 'active' && runtime.status === 'red') {
        drift.push({ level: 'error', message: `Marked active but not running (${runtime.detail})` });
    }

    return drift;
}

async function buildCatalog(options) {
    const opts = options || {};
    const now = Date.now();
    if (!opts.force && catalogCache && now - catalogCache.at < CATALOG_CACHE_TTL_MS) {
        return catalogCache.value;
    }

    const manifests = discoverManifests();
    const [snapshot, personaProbe] = await Promise.all([
        getDiscoverySnapshot({ force: opts.force }),
        probePersonas(manifests, opts.force)
    ]);
    const localDocker = localDockerState();

    const bots = manifests.map(manifest => {
        const live = livePersonasFor(manifest, personaProbe);
        const runtime = resolveRuntime(manifest, snapshot, localDocker);
        const git = manifest.projectRoot ? getGitInfo(manifest.projectRoot) : null;

        // Declared entries fill in names for personas the live config doesn't name.
        const declaredByTopic = new Map(manifest.personas.map(p => [String(p.topicId), p]));
        const personas = live.entries.length > 0
            ? live.entries.map(entry => ({
                ...entry,
                declaredName: (declaredByTopic.get(String(entry.topicId)) || {}).name || null,
                source: 'live'
            }))
            : manifest.personas.map(p => ({
                key: p.topicId ? `${(manifest.chats[0] || {}).id || '?'}:${p.topicId}` : p.name,
                chatId: (manifest.chats[0] || {}).id || null,
                topicId: p.topicId || null,
                name: p.name,
                prompt: p.prompt || null,
                allowed: true,
                declaredName: p.name,
                source: 'declared'
            }));

        return {
            id: manifest.id,
            name: manifest.name,
            aliases: manifest.aliases,
            platform: manifest.platform,
            lifecycle: manifest.lifecycle,
            summary: manifest.summary,
            notes: manifest.notes,
            deployment: manifest.deployment,
            chats: manifest.chats,
            project: { name: manifest.projectName, root: manifest.projectRoot },
            docs: manifest.docs,
            status: manifest.lifecycle === 'retired' ? 'retired' : runtime.status,
            statusDetail: runtime.detail,
            personaSourceKey: live.sourceKey,
            personaConfigVersion: live.configVersion || null,
            personas,
            git: git ? { lastCommitDate: git.lastCommitDate, commits7d: git.commits7d, recentCommits: git.recentCommits.slice(0, 5) } : null,
            drift: computeDrift(manifest, live, runtime)
        };
    });

    // Bots that exist in the VPS registry but have no repo manifest (no local
    // checkout, or nobody has written one yet). Listed so the catalog is a true
    // whole-fleet view rather than "the bots that happened to be documented".
    const claimedTargets = new Set(
        manifests.flatMap(m => [m.deployment.vpsBotId, m.deployment.container, m.deployment.service].filter(Boolean))
    );
    for (const entry of loadBots()) {
        if (entry.category !== 'bots') continue;
        if (claimedTargets.has(entry.id) || claimedTargets.has(entry.dockerContainer)) continue;

        const runtime = computeStatus(entry, snapshot.discovery, snapshot.pings[entry.id] || { ok: true }, snapshot.sshOk);
        bots.push({
            id: entry.id,
            name: entry.name,
            aliases: [],
            platform: 'unknown',
            lifecycle: 'active',
            summary: entry.description || '',
            notes: '',
            deployment: {
                kind: entry.dockerContainer ? 'vps-docker' : entry.systemdService ? 'vps-systemd' : 'unknown',
                vpsBotId: entry.id,
                container: entry.dockerContainer || null,
                service: entry.systemdService || null
            },
            chats: [],
            project: { name: entry.projectAlias || null, root: null },
            docs: [],
            status: runtime.status,
            statusDetail: runtime.detail,
            personaSourceKey: null,
            personas: [],
            git: null,
            registryOnly: true,
            drift: [{
                level: 'warn',
                message: 'No repo manifest — platform, personas and code location are unknown. Add .watchpost/bot.json to its repo.'
            }]
        });
    }

    // Personas configured live that no manifest claims — usually a bot someone
    // added on the VPS without a manifest, which is exactly what goes missing.
    const claimedKeys = new Set(bots.flatMap(b => b.personas.map(p => p.key)));
    const orphanPersonas = [];
    for (const source of Object.values(personaProbe.sources || {})) {
        for (const key of Object.keys(source.prompts || {})) {
            if (!claimedKeys.has(key)) {
                orphanPersonas.push({ key, prompt: source.prompts[key], sourceKey: source.sourceKey });
            }
        }
    }

    const value = {
        bots: bots.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name)),
        orphanPersonas,
        sshOk: snapshot.sshOk,
        sshError: snapshot.sshError,
        personaError: personaProbe.error,
        timestamp: new Date().toISOString()
    };

    catalogCache = { at: Date.now(), value };
    return value;
}

// ─── Agent-facing markdown ────────────────────────────────────────────────────

function renderMarkdown(catalog) {
    const lines = [];
    lines.push('# Bot fleet');
    lines.push('');
    lines.push('<!-- GENERATED by Watchpost (/api/bots/index.md) — do not edit by hand. -->');
    lines.push(`<!-- Generated ${catalog.timestamp} -->`);
    lines.push('');
    lines.push('Live source of truth for every bot: what it is, where its code lives, where it runs,');
    lines.push('and which personas it serves. Personas are read from each bot\'s running config, so');
    lines.push('this file beats any description written inside a bot\'s own repo.');
    lines.push('');
    lines.push(`Refresh: \`curl -s localhost:6010/api/bots/index.md\` · Lookup: \`curl -s "localhost:6010/api/bots/resolve?q=<name>"\``);
    lines.push('');

    if (catalog.sshError) lines.push(`> Runtime status unavailable this run (${catalog.sshError}); the rest is still accurate.\n`);
    if (catalog.personaError) lines.push(`> Live persona read failed (${catalog.personaError}); personas below may be the declared set.\n`);

    for (const bot of catalog.bots) {
        lines.push(`## ${bot.name}`);
        lines.push('');
        if (bot.summary) lines.push(bot.summary);
        if (bot.aliases.length) lines.push(`**Also called:** ${bot.aliases.join(', ')}`);
        lines.push(`**Platform:** ${bot.platform} · **Lifecycle:** ${bot.lifecycle} · **Status:** ${bot.status} (${bot.statusDetail})`);

        const target = bot.deployment.container || bot.deployment.service || bot.deployment.kind;
        lines.push(`**Runs as:** ${bot.deployment.kind}${target && target !== bot.deployment.kind ? ` \`${target}\`` : ''}`);
        if (bot.project.root) lines.push(`**Code:** \`${bot.project.root}\``);
        if (bot.chats.length) {
            lines.push(`**Chats:** ${bot.chats.map(c => `${c.label || 'chat'} (${c.id})`).join(', ')}`);
        }
        if (bot.git && bot.git.lastCommitDate) {
            lines.push(`**Last commit:** ${bot.git.lastCommitDate} (${bot.git.commits7d} in the last 7 days)`);
        }

        if (bot.personas.length) {
            lines.push('');
            lines.push('**Personas:**');
            for (const persona of bot.personas) {
                const where = persona.topicId ? ` — topic \`${persona.topicId}\`` : '';
                const summary = persona.prompt ? String(persona.prompt).replace(/\s+/g, ' ').slice(0, 200) : 'no prompt text available';
                lines.push(`- **${persona.name}**${where} (${persona.source}): ${summary}`);
            }
        }

        if (bot.notes) {
            lines.push('');
            lines.push(`**Notes:** ${bot.notes}`);
        }

        if (bot.drift.length) {
            lines.push('');
            lines.push('**Drift — documented state does not match reality:**');
            for (const item of bot.drift) lines.push(`- (${item.level}) ${item.message}`);
        }

        lines.push('');
    }

    if (catalog.orphanPersonas.length) {
        lines.push('## Unclaimed personas');
        lines.push('');
        lines.push('Configured on a live bot but not declared in any repo manifest:');
        for (const orphan of catalog.orphanPersonas) {
            lines.push(`- \`${orphan.key}\` — ${String(orphan.prompt).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function writeAgentIndex(markdown) {
    try {
        fs.mkdirSync(path.dirname(AGENT_INDEX_PATH), { recursive: true });
        fs.writeFileSync(AGENT_INDEX_PATH, markdown, 'utf8');
        return AGENT_INDEX_PATH;
    } catch (err) {
        console.error('[bots] Failed to write agent index:', err.message);
        return null;
    }
}

// ─── Alias resolution ─────────────────────────────────────────────────────────

function normalizeForMatch(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreMatch(bot, query) {
    const q = normalizeForMatch(query);
    if (!q) return 0;

    const exact = [bot.id, bot.name, ...bot.aliases, ...bot.personas.map(p => p.name)];
    for (const candidate of exact) {
        if (normalizeForMatch(candidate) === q) return 100;
    }

    const partial = [
        bot.id, bot.name, ...bot.aliases,
        ...bot.personas.map(p => p.name),
        bot.deployment.container, bot.deployment.service, bot.project.name
    ];
    for (const candidate of partial) {
        const c = normalizeForMatch(candidate);
        if (c && (c.includes(q) || q.includes(c))) return 60;
    }

    return 0;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

module.exports = function mountBotsRoutes(app) {

    // Refresh the agent-facing index once at startup, so an assistant asked about
    // a bot gets current facts even if nobody has opened the Bots tab. Deferred so
    // a slow or unreachable VPS never delays the server coming up.
    setTimeout(() => {
        buildCatalog({ force: true })
            .then(catalog => writeAgentIndex(renderMarkdown(catalog)))
            .catch(err => console.error('[bots] Startup index refresh failed:', err.message));
    }, 5000).unref();

    // GET /api/bots — full merged catalog
    app.get('/api/bots', async (req, res) => {
        try {
            const catalog = await buildCatalog({ force: req.query.refresh === '1' });
            // Keep the agent-facing file current as a side effect of any read.
            writeAgentIndex(renderMarkdown(catalog));
            res.json(catalog);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/bots/index.md — agent-readable fleet index
    app.get('/api/bots/index.md', async (req, res) => {
        try {
            const catalog = await buildCatalog({ force: req.query.refresh === '1' });
            const markdown = renderMarkdown(catalog);
            writeAgentIndex(markdown);
            res.type('text/markdown').send(markdown);
        } catch (err) {
            res.status(500).type('text/plain').send(`Failed to build bot index: ${err.message}`);
        }
    });

    // GET /api/bots/resolve?q=diet+bot — alias lookup for "what is X?"
    app.get('/api/bots/resolve', async (req, res) => {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: 'Pass ?q=<bot or persona name>' });

        try {
            const catalog = await buildCatalog({});
            const scored = catalog.bots
                .map(bot => ({ bot, score: scoreMatch(bot, query) }))
                .filter(entry => entry.score > 0)
                .sort((a, b) => b.score - a.score);

            if (scored.length === 0) {
                return res.status(404).json({
                    error: `No bot or persona matches "${query}"`,
                    known: catalog.bots.map(b => ({ id: b.id, name: b.name, aliases: b.aliases }))
                });
            }

            const best = scored[0].bot;
            const matchedPersona = best.personas.find(
                p => normalizeForMatch(p.name) === normalizeForMatch(query)
            ) || null;

            res.json({
                query,
                match: best,
                matchedPersona,
                otherCandidates: scored.slice(1, 4).map(entry => ({ id: entry.bot.id, name: entry.bot.name }))
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/bots/personas — live persona map on its own
    app.get('/api/bots/personas', async (req, res) => {
        try {
            const catalog = await buildCatalog({ force: req.query.refresh === '1' });
            const personas = catalog.bots.flatMap(bot =>
                bot.personas.map(persona => ({ botId: bot.id, botName: bot.name, ...persona }))
            );
            res.json({ personas, orphanPersonas: catalog.orphanPersonas, error: catalog.personaError });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/bots/:id — single bot detail. Registered last so the named routes win.
    app.get('/api/bots/:id', async (req, res) => {
        try {
            const catalog = await buildCatalog({});
            const bot = catalog.bots.find(b => b.id === req.params.id);
            if (!bot) return res.status(404).json({ error: `No bot with id "${req.params.id}"` });
            res.json(bot);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};

module.exports.helpers = { buildCatalog, renderMarkdown, discoverManifests, scoreMatch, AGENT_INDEX_PATH };
