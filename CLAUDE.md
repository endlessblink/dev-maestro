# Watchpost — Repo Instructions for Claude

## Quick: Set up Watchpost on a Windows + WSL2 machine

When the user asks Claude (running in WSL2 on their Windows machine) to "set up
Watchpost", "install Watchpost", "get Watchpost running", or similar — follow
this exact sequence. Do not improvise; this codebase has cross-OS path mapping
that needs the right env var.

### Step 1 — Verify environment

Before doing anything, confirm:

```bash
# Confirm we're in WSL2
[ -f /proc/sys/fs/binfmt_misc/WSLInterop ] && echo "WSL2 OK" || echo "NOT WSL2 — STOP and ask user"

# Confirm Node 18+ available
node --version

# Confirm /mnt/d is mounted (the user's project drive)
ls -d /mnt/d || echo "MISSING — ask the user where D: is mounted"
```

If any of these fail, stop and report to the user. Do not attempt a workaround.

### Step 2 — Clone or pull

```bash
if [ -d ~/.watchpost/.git ]; then
    cd ~/.watchpost && git pull origin main
else
    git clone https://github.com/endlessblink/watchpost.git ~/.watchpost
    cd ~/.watchpost
fi
npm install
```

### Step 3 — Write `.env` with the D:/ ↔ /mnt/d path mapping

This is the load-bearing step. Without it, Watchpost can't reconcile project
paths when Claude on the Windows side writes transcripts referencing `D:\…` and
Watchpost in WSL2 needs to match them to a project rooted at `/mnt/d/…`.

```bash
cat > ~/.watchpost/.env <<'EOF'
PORT=6010
WATCHPOST_PATH_MAPPINGS=[{"linux":"/mnt/d","windows":"D:\\"},{"linux":"/mnt/c","windows":"C:\\"}]
EOF
```

If the user has a different drive layout, ask before changing the mapping.

### Step 4 — Start the server

```bash
cd ~/.watchpost && npm start
```

Then tell the user to open `http://localhost:6010` in their Windows browser
(WSL2 forwards localhost automatically — no extra port-forwarding needed).

### Step 5 — Verify

```bash
curl -sG --data-urlencode "cwd=$(pwd)" http://localhost:6010/api/status \
    | python3 -m json.tool
```

`running: true` means it's live. If `projectName` comes back null and the user
expects a registered project, the path mapping or projects.json is wrong —
re-read `docs/WINDOWS.md`.

---

## Key facts for any Claude session in this repo

- **Server entrypoint:** `server.js` (mounts `controlroom/api.js` and `vps/api.js`).
- **Cross-platform paths:** every install location flows through `lib/paths.js`.
  Do not reintroduce hardcoded `process.env.HOME` or `/home/...` paths anywhere.
- **Path mapping:** if you write code that consumes a stored project path, run
  it through `wpPaths.mapPathToCurrentOS()` before `path.resolve()`. Otherwise
  Windows paths on Linux (or vice versa) will produce garbage when the same
  `projects.json` is shared.
- **Windows specifics:** see `docs/WINDOWS.md` for the full matrix (WSL-backed
  vs native Windows, scheduled task on logon, troubleshooting). Do NOT recommend
  `scripts/install-windows.ps1` to a WSL2 user — that's for parallel native
  installs and is redundant under WSL2.
- **MASTER_PLAN.md task titles:** max 80 chars (Watchpost API rejects longer).
  Put detail in the `####` body, not the table title.

## What NOT to do

- Don't add a path mapping to `projects.json` or `.env` on a machine where the
  Linux side of the mapping doesn't actually exist (e.g. don't add `/mnt/d ↔ D:\`
  on a native Linux box that has no `/mnt/d`).
- Don't run `scripts/install-windows.ps1` from inside WSL2 — it's a PowerShell
  script meant for native-Windows shells.
- Don't commit `.env` (already in `.gitignore`). The path mapping is per-machine.
