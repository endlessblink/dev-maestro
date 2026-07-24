import { describe, expect, it } from 'vitest';

// Pure helpers only — no SSH, no filesystem, no live catalog build.
const { helpers } = await import('../../bots/api.js');
const { scoreMatch, personaNameFromPrompt, renderMarkdown } = helpers;

// A bot shaped like buildCatalog's output, enough for the pure helpers.
const hermes = {
    id: 'hermes-gateway',
    name: 'Hermes Gateway',
    aliases: ['diet bot', 'diet-bot', 'food bot', 'excersize bot'],
    platform: 'telegram',
    deployment: { container: 'hermes-gateway' },
    project: { name: 'hermes-agent', root: '/home/x/.hermes/hermes-agent' },
    personas: [
        { name: 'Diet Bot', topicId: '306' },
        { name: 'excersize bot', topicId: '303' }
    ]
};

const worlds = {
    id: 'worlds-greatest-bot',
    name: "World's Greatest Bot",
    aliases: ['wgb'],
    platform: 'discord',
    deployment: { container: 'worlds-greatest-bot' },
    project: { name: 'worlds-greatest-bot', root: '/x/wgb' },
    personas: []
};

describe('bot catalog — alias resolution', () => {
    // The whole point of the catalog: "diet bot" must resolve to the bot that
    // actually serves that persona, not to nothing and not to the wrong bot.
    it('resolves a persona alias to its host bot with an exact score', () => {
        expect(scoreMatch(hermes, 'diet bot')).toBe(100);
        expect(scoreMatch(hermes, 'Diet Bot')).toBe(100);   // case-insensitive
        expect(scoreMatch(hermes, 'diet-bot')).toBe(100);   // punctuation-insensitive
    });

    it('matches a persona by its live name even when not in aliases', () => {
        const noAlias = { ...hermes, aliases: [] };
        expect(scoreMatch(noAlias, 'excersize bot')).toBe(100);
    });

    it('partial-matches container and project names', () => {
        expect(scoreMatch(worlds, 'worlds greatest')).toBeGreaterThan(0);
        expect(scoreMatch(hermes, 'hermes')).toBeGreaterThan(0);
    });

    it('does not match an unrelated query', () => {
        expect(scoreMatch(worlds, 'diet bot')).toBe(0);
        expect(scoreMatch(hermes, 'supabase')).toBe(0);
    });

    it('ranks the diet-bot query to exactly one bot across the fleet', () => {
        const scored = [hermes, worlds]
            .map(b => ({ b, s: scoreMatch(b, 'diet bot') }))
            .filter(x => x.s > 0);
        expect(scored).toHaveLength(1);
        expect(scored[0].b.id).toBe('hermes-gateway');
    });
});

describe('bot catalog — persona name extraction', () => {
    // Personas name themselves in the first clause of their live prompt; the
    // parser must pull that out and drop the leading emoji.
    it('extracts the persona name from the live prompt first clause', () => {
        expect(personaNameFromPrompt('🍓 Diet Bot (topic 306). This topic owns food…'))
            .toBe('Diet Bot');
        expect(personaNameFromPrompt('🏆 excersize bot (topic 303). Owns exercise…'))
            .toBe('excersize bot');
    });

    it('returns null for empty prompt text', () => {
        expect(personaNameFromPrompt('')).toBeNull();
        expect(personaNameFromPrompt(null)).toBeNull();
    });
});

describe('bot catalog — agent markdown index', () => {
    const catalog = {
        bots: [{
            ...hermes,
            lifecycle: 'active',
            summary: 'The live Telegram bot.',
            notes: 'Shares the token with claude-and-conquer.',
            status: 'green',
            statusDetail: 'running',
            chats: [{ id: '-1004230590253', label: 'Concil of bots' }],
            git: { lastCommitDate: '2026-07-19 20:51:52 +0300', commits7d: 3, recentCommits: [] },
            personas: [
                { name: 'Diet Bot', topicId: '306', source: 'live', prompt: '🍓 Diet Bot (topic 306). Owns food.' }
            ],
            drift: []
        }],
        orphanPersonas: [],
        timestamp: '2026-07-24T00:00:00.000Z'
    };

    it('renders a do-not-edit header so the generated file is not hand-edited', () => {
        expect(renderMarkdown(catalog)).toContain('do not edit by hand');
    });

    it('includes the persona, its topic id and where the code lives', () => {
        const md = renderMarkdown(catalog);
        expect(md).toContain('Diet Bot');
        expect(md).toContain('306');
        expect(md).toContain('/home/x/.hermes/hermes-agent');
    });

    it('surfaces drift when present', () => {
        const withDrift = {
            ...catalog,
            bots: [{ ...catalog.bots[0], drift: [{ level: 'error', message: 'Declared persona on topic 999 is not in the live config' }] }]
        };
        expect(renderMarkdown(withDrift)).toContain('topic 999');
    });
});
