---
name: bot-fleet
description: Use when asked about any of Noam's bots or bot personas — "diet bot", "excersize bot", "orchestrator bot", "paper-bot", "personal-assistany", "botson", "botty", "world's greatest bot", "bina bot", "claude and conquer", "hermes gateway", "Concil of bots" — or about the fleet generally ("which bots do I have", "where does bot X run", "what platform is X on", "what persona is in topic N", "is bot X running", "where does bot X's code live"). Also use before editing a bot's config, prompt, or deployment, so you act on live state rather than a repo doc.
---

# Bot fleet

Noam's bots are spread across a VPS, this workstation, several repos, and — for the
Telegram ones — several *personas inside a single process*. A bot's own repo doc is
not reliable: personas move between config keys, and repo notes go stale within days.
Watchpost keeps a live catalog. Use it.

## How to answer a question about a bot

1. **Read the generated index first** — `~/.claude/knowledge/bot-fleet.md`. It covers
   every bot: platform, where it runs, repo path, personas with topic ids, lifecycle,
   and any drift between what's documented and what's deployed. This works even when
   Watchpost is stopped.

2. **For a single bot or persona, resolve it directly** (Watchpost running):
   ```bash
   curl -s "localhost:6010/api/bots/resolve?q=diet+bot"
   ```
   Alias-aware — "diet bot", "diet-bot" and "food bot" all resolve to the bot that
   actually serves that persona. The response includes the live system prompt.

3. **For the whole fleet with current runtime status:**
   ```bash
   curl -s localhost:6010/api/bots | head -c 4000     # JSON
   curl -s localhost:6010/api/bots/index.md           # markdown, also rewrites the file above
   ```

If Watchpost is not running, the generated file is still the best source; say that
its runtime status may be stale rather than guessing.

## Rules

- **Live config beats repo docs.** Personas are read from each bot's running config.
  Where a repo's CLAUDE.md/README disagrees, the catalog is right and the repo is stale
  — say so, and offer to fix the repo doc.
- **A persona is not a bot.** "Diet Bot" is a Telegram topic persona served by the
  `hermes-gateway` process, not its own deployment. Answer at the level asked, but make
  the relationship clear before anyone tries to restart "the diet bot".
- **A stopped container is not always an outage.** Some bots are stopped on purpose
  (token conflicts). The catalog marks those `retired` — do not "fix" them.
- **Report drift.** If the catalog flags drift for the bot in question, mention it;
  that is usually the real answer to "why is this behaving oddly".

## Adding a bot to the catalog

Create `.watchpost/bot.json` in the bot's repo. It is picked up automatically — no
Watchpost change needed. Repos outside the scanned tree can be added to
`botManifestRoots` in Watchpost's `local/config.json`.

```json
{
  "id": "my-bot",
  "name": "My Bot",
  "aliases": ["nickname people actually use"],
  "platform": "telegram",
  "lifecycle": "active",
  "summary": "One line on what it does.",
  "deployment": { "kind": "vps-docker", "vpsBotId": "my-bot", "container": "my-bot" },
  "chats": [{ "id": "-100…", "label": "Group name" }],
  "personaSource": { "kind": "hermes-config", "path": "/opt/hermes-data/config.yaml" },
  "personas": [{ "topicId": "306", "name": "Diet Bot" }],
  "notes": "Gotchas worth knowing before touching it."
}
```

`deployment.kind`: `vps-docker` · `vps-systemd` · `local-docker` · `local` · `none`.
`lifecycle`: `active` · `dormant` · `retired`.
Declared `personas` are compared against live config — a mismatch surfaces as drift,
which is the point. Omit `personaSource` for bots with no readable persona config.

Never hand-edit `~/.claude/knowledge/bot-fleet.md` — it is regenerated and your edit
will be overwritten. Fix the manifest or the bot's live config instead.
