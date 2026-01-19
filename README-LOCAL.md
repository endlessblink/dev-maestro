# Local Customizations

Customize Dev Maestro without losing changes on updates.

All files in the `local/` directory are preserved during auto-updates and git pulls.

## Directory Structure

```
~/.dev-maestro/local/
├── icons/
│   ├── favicon.ico       # Custom browser tab icon
│   └── favicon.svg       # Custom SVG icon
├── css/
│   └── custom.css        # Custom styles (available at /css/custom.css)
├── views/
│   ├── kanban/
│   │   └── index.html    # Custom kanban board
│   ├── stats/
│   │   └── index.html    # Custom stats page
│   └── skills/
│       └── index.html    # Custom skills page
└── config.json           # Behavior settings
```

## Config Options

Edit `~/.dev-maestro/local/config.json`:

```json
{
  "port": 6010,              // Server port (default: 6010)
  "autoUpdate": true,        // Auto-update on launch (default: true)
  "updateBranch": "main",    // Git branch to track (default: "main")
  "showUpdateNotifications": true  // Show update messages (default: true)
}
```

## Override Precedence

When requesting a file, Dev Maestro checks in this order:

1. **Local icons** - `local/icons/favicon.ico` → `/favicon.ico`
2. **Local views** - `local/views/kanban/index.html` → `/kanban/index.html`
3. **Local CSS** - `local/css/custom.css` → `/css/custom.css`
4. **Default files** - Bundled files in root directory

## Examples

### Custom Favicon

Replace the browser tab icon:

```bash
# Copy your icon to the local directory
cp ~/my-custom-icon.ico ~/.dev-maestro/local/icons/favicon.ico

# Restart Dev Maestro
./maestro.sh
```

### Custom CSS Theme

Add custom styles that apply to all pages:

```bash
cat > ~/.dev-maestro/local/css/custom.css << 'EOF'
/* Custom accent color */
:root {
  --accent-color: #ff6b6b;
  --surface-primary: #1a1a2e;
}

/* Custom task card styling */
.task-card {
  border-left: 3px solid var(--accent-color);
}
EOF
```

Then reference it in your view HTML or inject via browser extension.

### Custom View Template

Override an entire view page:

```bash
# Copy default view as starting point
mkdir -p ~/.dev-maestro/local/views/kanban
cp ~/.dev-maestro/kanban/index.html ~/.dev-maestro/local/views/kanban/

# Edit with your customizations
nano ~/.dev-maestro/local/views/kanban/index.html

# Restart to see changes
./maestro.sh
```

### Disable Auto-Updates

```bash
# Via config file
cat > ~/.dev-maestro/local/config.json << 'EOF'
{
  "port": 6010,
  "autoUpdate": false
}
EOF

# Or one-time skip via flag
./maestro.sh --no-update
```

### Change Port

```bash
cat > ~/.dev-maestro/local/config.json << 'EOF'
{
  "port": 6020
}
EOF

# Dev Maestro will now run on port 6020
./maestro.sh
```

## Migration

When updating from a version without the local/ system:

1. Existing customizations to tracked files (like favicon.ico) will be detected
2. They'll be automatically migrated to `local/icons/` or `local/views/`
3. Original tracked files are restored to match the repository

## Backup Recommendation

Back up your customizations periodically:

```bash
cp -r ~/.dev-maestro/local ~/dev-maestro-local-backup
```

## Troubleshooting

### My custom icon isn't showing

1. Check the file exists: `ls -la ~/.dev-maestro/local/icons/`
2. Clear browser cache (Ctrl+Shift+R)
3. Check server logs: `npm start` shows `[Override] Serving local view:` when overrides are used

### My custom CSS isn't loading

1. Verify the file: `cat ~/.dev-maestro/local/css/custom.css`
2. The CSS is served at `/css/custom.css` - you need to include it in your HTML
3. For global injection, modify your local view template to include:
   ```html
   <link rel="stylesheet" href="/css/custom.css">
   ```

### Config changes not taking effect

1. Stop Dev Maestro (Ctrl+C)
2. Verify JSON syntax: `cat ~/.dev-maestro/local/config.json | python3 -m json.tool`
3. Restart: `./maestro.sh`

### Auto-update keeps failing

1. Check network: `ping github.com`
2. Check git remote: `cd ~/.dev-maestro && git remote -v`
3. Disable temporarily: `./maestro.sh --no-update`
