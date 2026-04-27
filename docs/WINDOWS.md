# Watchpost on Windows

Watchpost runs in two supported modes on Windows:

1. **WSL-backed** — recommended. Run Watchpost inside WSL/Linux, open it from
   Windows at `http://localhost:6010`. Fastest path; keeps existing Linux
   paths/logs working unchanged.
2. **Native Windows** — for when you don't want a WSL dependency. Runs
   directly under PowerShell + Node.js with Windows-native paths.

You can also combine them: install on both sides and use path mappings so the
same `projects.json` resolves on both.

---

## Mode 1: WSL-backed (recommended)

In a WSL shell:

```bash
git clone https://github.com/endlessblink/watchpost.git ~/.watchpost
cd ~/.watchpost
npm install
npm start
```

Then in Windows, open `http://localhost:6010`. WSL forwards localhost
automatically. No further config needed.

---

## Mode 2: Native Windows

### Prerequisites

- Node.js 18+ from https://nodejs.org/
- PowerShell 5.1 (Windows 10+) or PowerShell 7

### Install

In a normal (non-elevated) PowerShell:

```powershell
git clone https://github.com/endlessblink/watchpost.git $env:USERPROFILE\.watchpost
cd $env:USERPROFILE\.watchpost
.\scripts\install-windows.ps1
```

What this does:

1. Runs `npm install`.
2. Adds `<repo>\bin` to your **user** PATH (no admin needed).
3. Leaves you with a `watchpost` command available in any new shell.

Open a new shell and run:

```powershell
watchpost
```

Visit `http://localhost:6010`.

### Start on logon

```powershell
.\scripts\install-windows.ps1 -InstallService
```

Registers a per-user Scheduled Task that starts Watchpost hidden at logon.
To remove it:

```powershell
.\scripts\install-windows.ps1 -Uninstall
```

### Launcher commands

```powershell
watchpost              # start the dashboard server (foreground)
watchpost dashboard    # same as above (compat with bash launcher)
watchpost status       # ping /api/status
watchpost open         # open the dashboard in the default browser
watchpost help         # show usage
```

To stop a foreground server, use Ctrl+C. To stop the scheduled-task copy:
`Stop-ScheduledTask -TaskName Watchpost`.

---

## Path mappings (for shared projects.json)

If your Linux + Windows installs share the same project storage (dual-boot
with NTFS, WSL on `/mnt/c`, etc.), declare path mappings so Watchpost can
remap stored paths on the fly. You can do this either in `.env` or directly
in `projects.json`.

### Option A — `.env`

```ini
WATCHPOST_PATH_MAPPINGS=[{"linux":"/media/endlessblink/data","windows":"D:\\"},{"linux":"/home/endlessblink","windows":"C:\\Users\\endlessblink"}]
```

### Option B — `projects.json`

```json
{
  "pathMappings": [
    { "linux": "/media/endlessblink/data", "windows": "D:\\" },
    { "linux": "/home/endlessblink", "windows": "C:\\Users\\endlessblink" }
  ],
  "projects": [ ... ]
}
```

When Watchpost reads a project root that's stored as a Linux path while
running on Windows (or vice versa), it remaps it through the matching prefix.
Unmapped paths are left untouched.

> **Configure mappings on both OSes.** Auto-discovery in `findProjectForCwd`
> writes new project entries using the *current OS*'s paths. If only one side
> has mappings configured, the other side will see foreign paths it can't
> resolve. The mapping rule should live in both installs.

### Verification

```powershell
node -e "console.log(require('./lib/paths').mapPathToCurrentOS('/media/endlessblink/data/my-projects/foo'))"
```

Should print `D:\my-projects\foo` if the mapping is in effect.

---

## Multi-source log scanning

When Claude Code runs on both Windows and inside WSL, both write transcripts
to different `.claude/projects` dirs. Tell Watchpost to scan both:

```ini
WATCHPOST_CLAUDE_PROJECTS_DIRS=C:\Users\you\.claude\projects,\\wsl$\Ubuntu\home\you\.claude\projects
```

Use `;` or `,` as the separator. Same pattern for OpenCode:

```ini
WATCHPOST_OPENCODE_STORAGE_DIRS=%APPDATA%\opencode\storage,\\wsl$\Ubuntu\home\you\.local\share\opencode\storage
```

The dashboard will surface sessions from every configured source.

---

## Known Windows-specific differences

| Feature | Status |
|---------|--------|
| Dashboard UI | ✅ Works identically |
| MASTER_PLAN.md parsing / Kanban / Flow | ✅ Works |
| Claude transcript scanning (`/api/changelog`, `/api/active-sessions`) | ✅ Works (uses `%USERPROFILE%\.claude` by default) |
| OpenCode transcript scanning | ✅ Works (uses `%APPDATA%\opencode` by default) |
| Sessions heartbeat API + JSONL | ✅ Works |
| Health scanner | ✅ Works (Node-based) |
| **VPS tab (SSH ControlMaster)** | ⚠️ Falls back to per-call SSH on Windows. Slower (~500ms vs ~50ms) but functional. Use WSL mode for the fastest VPS view. |
| `/api/changelog` path joins from foreign-OS sessions | ✅ Remapped via `mapPathToCurrentOS` if path mappings are configured |

---

## Troubleshooting

**`watchpost: command not found` after install.**
Open a *new* PowerShell. PATH changes don't apply to the shell that ran the installer.

**Dashboard says no projects.**
Confirm `WATCHPOST_PROJECTS_FILE` (or the default `<repo>\projects.json`) exists
and contains your registry. If you copied it from Linux, set up
`WATCHPOST_PATH_MAPPINGS` so the Linux paths inside resolve on Windows.

**Logs tab is empty.**
Set `WATCHPOST_CLAUDE_PROJECTS_DIRS` (and `WATCHPOST_OPENCODE_STORAGE_DIRS`)
to point at the actual transcript dirs. Check by listing them in PowerShell:
`ls $env:USERPROFILE\.claude\projects`.

**Scheduled task not starting.**
`Get-ScheduledTaskInfo -TaskName Watchpost` shows last run / result. The task
runs hidden — open `http://localhost:6010` to confirm or check
`watchpost status` in any shell.

**Need to undo everything.**
```powershell
.\scripts\install-windows.ps1 -Uninstall   # removes scheduled task
# Then manually remove <repo>\bin from PATH via System Properties → Environment Variables
```
