# Dev Maestro - Claude Code Integration Improvements

This document contains directions for Claude Code to improve the dev-maestro installation and integration experience.

---

## Context

A user tried installing dev-maestro and encountered these issues:
1. Running `PROJECT_ROOT=/path curl ... | bash` didn't pass the variable to the script
2. The installer assumed MASTER_PLAN.md was at `PROJECT_ROOT/docs/MASTER_PLAN.md` (hardcoded path)
3. Claude Code instances didn't have a way to interact with dev-maestro (no MCP server)
4. The generated `maestro.sh` launcher used wrong paths
5. No clear integration path for Claude Code users

## Completed Improvements

### 1. MCP Server Created (`mcp-server.js`)

An MCP (Model Context Protocol) server was created that provides these tools to Claude Code:

| Tool | Description |
|------|-------------|
| `maestro_get_tasks` | Get all tasks from MASTER_PLAN.md |
| `maestro_get_task` | Get a specific task by ID |
| `maestro_update_status` | Update task status in MASTER_PLAN.md |
| `maestro_next_id` | Get next available task ID |
| `maestro_health` | Get project health report |
| `maestro_master_plan` | Get raw MASTER_PLAN.md content |

### 2. MCP Setup Script (`scripts/setup-mcp.sh`)

A script that creates `.mcp.json` in any project directory with the correct configuration.

### 3. Updated Documentation

- README.md updated with MCP setup instructions
- CLAUDE_INSTRUCTIONS.md updated with .mcp.json format
- templates/mcp-config.json created as template

---

## Remaining Improvements Needed

### Priority 1: Installer Enhancements

**File: `install.sh`**

1. **Add argument parsing for project path:**
```bash
# Add at top of script
while [[ $# -gt 0 ]]; do
    case $1 in
        --project|-p)
            PROJECT_ROOT="$2"
            shift 2
            ;;
        --master-plan|-m)
            MASTER_PLAN_PATH_ARG="$2"
            shift 2
            ;;
        --setup-mcp)
            SETUP_MCP=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done
```

2. **Auto-detect MASTER_PLAN.md location:**
```bash
find_master_plan() {
    local project_root="$1"
    local locations=(
        "$project_root/MASTER_PLAN.md"
        "$project_root/docs/MASTER_PLAN.md"
        "$project_root/planning/MASTER_PLAN.md"
    )
    for loc in "${locations[@]}"; do
        [ -f "$loc" ] && echo "$loc" && return 0
    done
    find "$project_root" -maxdepth 3 -name "MASTER_PLAN.md" -type f 2>/dev/null | head -1
}
```

3. **Interactive project setup on fresh install:**
```bash
if [ ! -f ".env" ]; then
    read -p "Enter path to your project (or press Enter to skip): " PROJECT_INPUT
    if [ -n "$PROJECT_INPUT" ] && [ -d "$PROJECT_INPUT" ]; then
        MASTER_PLAN=$(find_master_plan "$PROJECT_INPUT")
        if [ -n "$MASTER_PLAN" ]; then
            echo "MASTER_PLAN_PATH=$MASTER_PLAN" >> .env
            echo -e "${GREEN}✓ Configured MASTER_PLAN_PATH${NC}"
        fi
    fi
fi
```

4. **Auto-setup MCP when project is specified:**
```bash
if [ -n "$PROJECT_ROOT" ] && [ "$SETUP_MCP" = true ]; then
    "$INSTALL_DIR/scripts/setup-mcp.sh" "$PROJECT_ROOT"
fi
```

### Priority 2: Dynamic maestro.sh Generator

**Current problem:** The generated `maestro.sh` hardcodes `docs/MASTER_PLAN.md`

**Fix:** Use the actual configured path from .env

```bash
# In install.sh, when generating maestro.sh
ACTUAL_MASTER_PLAN_PATH=$(grep -E "^MASTER_PLAN_PATH=" "$INSTALL_DIR/.env" | cut -d= -f2)

cat > "$PROJECT_ROOT/maestro.sh" << LAUNCHER
#!/bin/bash
export MASTER_PLAN_PATH="$ACTUAL_MASTER_PLAN_PATH"
cd "$INSTALL_DIR" && npm start
LAUNCHER
```

### Priority 3: Reconfigure Command

Add a `--reconfigure` flag to easily switch projects:

```bash
if [ "$1" = "--reconfigure" ]; then
    read -p "Enter path to MASTER_PLAN.md: " NEW_PATH
    if [ -f "$NEW_PATH" ]; then
        NEW_PATH=$(realpath "$NEW_PATH")
        sed -i "s|^MASTER_PLAN_PATH=.*|MASTER_PLAN_PATH=$NEW_PATH|" "$INSTALL_DIR/.env"
        echo "Updated to: $NEW_PATH"

        # Restart if running
        pkill -f "node.*server.js" 2>/dev/null
        cd "$INSTALL_DIR" && npm start &
    fi
    exit 0
fi
```

### Priority 4: API Endpoint for Runtime Config

**File: `server.js`**

Add endpoint to change project without restart:

```javascript
app.post('/api/config/master-plan', (req, res) => {
    const { path } = req.body;
    if (!path || !fs.existsSync(path)) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    // Update .env
    const envPath = path.join(__dirname, '.env');
    let env = fs.readFileSync(envPath, 'utf8');
    env = env.replace(/^MASTER_PLAN_PATH=.*/m, `MASTER_PLAN_PATH=${path}`);
    fs.writeFileSync(envPath, env);

    // Update runtime
    process.env.MASTER_PLAN_PATH = path;

    res.json({ success: true, path });
});
```

### Priority 5: One-liner Installation with Project

Update README to show full installation:

```bash
# Install + configure for a project
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | \
    bash -s -- --project /path/to/project --setup-mcp

# Or if already installed, just configure
~/.dev-maestro/install.sh --project /path/to/project --setup-mcp
```

---

## Testing Checklist

After implementing changes:

- [ ] Fresh install without arguments prompts for project
- [ ] `--project` flag correctly sets MASTER_PLAN_PATH
- [ ] `--setup-mcp` creates .mcp.json in project
- [ ] MASTER_PLAN.md at root level is detected
- [ ] MASTER_PLAN.md in docs/ folder is detected
- [ ] Generated maestro.sh uses correct paths
- [ ] MCP server connects to API successfully
- [ ] `--reconfigure` changes project correctly
- [ ] Update preserves existing .env settings

---

## Files Modified/Created in This Session

| File | Status | Description |
|------|--------|-------------|
| `mcp-server.js` | **NEW** | MCP server for Claude Code integration |
| `scripts/setup-mcp.sh` | **NEW** | Script to add .mcp.json to projects |
| `templates/mcp-config.json` | Updated | Template for .mcp.json |
| `templates/CLAUDE_INSTRUCTIONS.md` | Updated | Added MCP setup instructions |
| `README.md` | Updated | Added MCP integration section |
| `INSTALLER_IMPROVEMENTS.md` | **NEW** | Detailed installer improvement specs |

---

## Quick Reference for Claude Code

When a user asks to use dev-maestro:

1. **Check if server is running:**
   ```bash
   curl -s http://localhost:6010/api/status
   ```

2. **Start if not running:**
   ```bash
   cd ~/.dev-maestro && npm start &
   ```

3. **Check if MCP is configured:**
   Look for `.mcp.json` in project root with `dev-maestro` entry

4. **Use the API directly if MCP not available:**
   ```bash
   # Get tasks
   curl -s http://localhost:6010/api/master-plan

   # Update status
   curl -X POST http://localhost:6010/api/task/TASK-001/status \
       -H "Content-Type: application/json" \
       -d '{"status": "in-progress"}'
   ```
