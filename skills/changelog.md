---
name: changelog
description: Query the agent action changelog to debug issues and trace which agent changed what file. Use when debugging, investigating file changes, or reviewing session history. Triggers on "/changelog", "what changed", "who modified", "trace back", "what happened", "file history", "session history", "recent changes".
---

# Changelog Query Skill

When this skill is invoked, query the Dev Maestro changelog API to show agent action history.

## How to Use

Parse the user's query for filters:
- `/changelog` — show last 20 actions for the current project
- `/changelog file:<path>` — show all changes to files matching <path>
- `/changelog tool:<name>` — filter by tool (Write, Edit, Bash, Agent)
- `/changelog session:last` — show all actions from the most recent session
- `/changelog last:<period>` — show actions from last period (1h, 6h, 24h, 7d)
- `/changelog failures` — show only failed actions

## Implementation

1. Determine the current project name from the working directory basename
2. Build the API URL based on filters
3. Execute: `curl -s "http://localhost:6010/api/changelog/actions?project=<project>&<filters>&limit=50"`
4. Parse the JSON response
5. Format as a readable markdown table

### API Endpoints

- Actions: `GET http://localhost:6010/api/changelog/actions?project=<name>&tool=<tool>&file=<path>&since=<ISO>&limit=<n>`
- File history: `GET http://localhost:6010/api/changelog/file-history?file=<path>&project=<name>`
- Stats: `GET http://localhost:6010/api/changelog/stats?project=<name>&period=<period>`
- Sessions: `GET http://localhost:6010/api/changelog/sessions?project=<name>&limit=10`

### Output Format

Present results as a markdown table:
```
| Time | Agent | Tool | File/Command | Summary |
|------|-------|------|-------------|---------|
| 2m ago | conductor | Write | src/store/bg.ts | Add background slice |
```

### Fallback

If Dev Maestro is not running (curl fails), fall back to reading raw JSONL:
```bash
tail -n 50 ~/.dev-maestro/data/changelog/<project>.jsonl | jq -r '[.ts, .agent, .tool, .file // .cmd // "—", .summary[:80]] | @tsv'
```

### Tips
- When debugging "what changed this file", use the file-history endpoint
- When investigating a session, use session filter to see the full trace
- Stats endpoint gives a quick overview of activity
