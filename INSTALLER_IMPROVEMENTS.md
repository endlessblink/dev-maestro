# Dev Maestro Installer Improvements

## Problem Statement

When installing dev-maestro for a specific project, users face these friction points:

1. **Environment variables don't work with curl pipe**: Running `PROJECT_ROOT=/path curl ... | bash` doesn't pass the variable to the script
2. **Hardcoded MASTER_PLAN.md path**: The installer assumes `PROJECT_ROOT/docs/MASTER_PLAN.md` but many projects have it at root level
3. **No interactive project setup**: On fresh install, user must manually edit `.env` to point to their project
4. **Updates don't offer to change project**: When updating, there's no prompt to switch which project is being tracked
5. **maestro.sh assumes wrong path**: The generated launcher script hardcodes `docs/MASTER_PLAN.md`

## Suggested Improvements

### 1. Support Multiple Installation Methods

```bash
# Method 1: Interactive (prompts for project path)
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash

# Method 2: With project path argument
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash -s -- --project /path/to/project

# Method 3: Download and run (preserves env vars)
curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh -o /tmp/install-maestro.sh
PROJECT_ROOT=/path/to/project bash /tmp/install-maestro.sh
```

### 2. Add Interactive Project Detection

After installing dependencies, add:

```bash
# Interactive project setup for new installs
if [ ! -f ".env" ] || [ -z "$(grep MASTER_PLAN_PATH .env)" ]; then
    echo -e "${BLUE}Project Setup${NC}"

    # Try to auto-detect from current directory
    DETECTED_PROJECT=""
    if [ -f "$PWD/MASTER_PLAN.md" ]; then
        DETECTED_PROJECT="$PWD/MASTER_PLAN.md"
    elif [ -f "$PWD/docs/MASTER_PLAN.md" ]; then
        DETECTED_PROJECT="$PWD/docs/MASTER_PLAN.md"
    fi

    if [ -n "$DETECTED_PROJECT" ]; then
        echo -e "Detected MASTER_PLAN.md at: ${GREEN}$DETECTED_PROJECT${NC}"
        read -p "Use this path? [Y/n]: " USE_DETECTED
        if [[ "$USE_DETECTED" =~ ^[Nn] ]]; then
            DETECTED_PROJECT=""
        fi
    fi

    if [ -z "$DETECTED_PROJECT" ]; then
        read -p "Enter path to your MASTER_PLAN.md (or press Enter to skip): " MASTER_PLAN_INPUT
        if [ -n "$MASTER_PLAN_INPUT" ]; then
            DETECTED_PROJECT="$MASTER_PLAN_INPUT"
        fi
    fi

    if [ -n "$DETECTED_PROJECT" ]; then
        # Resolve to absolute path
        DETECTED_PROJECT=$(realpath "$DETECTED_PROJECT" 2>/dev/null || echo "$DETECTED_PROJECT")
        sed -i "s|^MASTER_PLAN_PATH=.*|MASTER_PLAN_PATH=$DETECTED_PROJECT|" .env
        echo -e "${GREEN}✓ Configured MASTER_PLAN_PATH${NC}"
    fi
fi
```

### 3. Add `--project` Argument Support

Add argument parsing at the top of the script:

```bash
# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --project|-p)
            PROJECT_ROOT="$2"
            shift 2
            ;;
        --master-plan|-m)
            MASTER_PLAN_PATH="$2"
            shift 2
            ;;
        --start)
            START_AFTER_INSTALL=true
            shift
            ;;
        --help|-h)
            echo "Usage: install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --project, -p PATH     Project root directory"
            echo "  --master-plan, -m PATH Direct path to MASTER_PLAN.md"
            echo "  --start                Start server after installation"
            echo "  --help, -h             Show this help"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done
```

### 4. Auto-detect MASTER_PLAN.md Location

Replace the hardcoded path logic with smart detection:

```bash
find_master_plan() {
    local project_root="$1"

    # Check common locations in order of preference
    local locations=(
        "$project_root/MASTER_PLAN.md"
        "$project_root/docs/MASTER_PLAN.md"
        "$project_root/planning/MASTER_PLAN.md"
        "$project_root/.github/MASTER_PLAN.md"
    )

    for loc in "${locations[@]}"; do
        if [ -f "$loc" ]; then
            echo "$loc"
            return 0
        fi
    done

    # Fallback: search for it
    local found=$(find "$project_root" -maxdepth 3 -name "MASTER_PLAN.md" -type f 2>/dev/null | head -1)
    if [ -n "$found" ]; then
        echo "$found"
        return 0
    fi

    return 1
}
```

### 5. Fix maestro.sh Generator

Update the launcher generator to use the actual detected path:

```bash
# Store the actual MASTER_PLAN_PATH for the launcher
ACTUAL_MASTER_PLAN_PATH=$(grep -E "^MASTER_PLAN_PATH=" .env | cut -d= -f2 | tr -d '"' | tr -d "'")

cat > "$PROJECT_ROOT/maestro.sh" << LAUNCHER
#!/bin/bash
# Dev Maestro Launcher for $(basename "$PROJECT_ROOT")

INSTALL_DIR="$HOME/.dev-maestro"

if [ ! -d "\$INSTALL_DIR" ]; then
    echo "Dev Maestro not installed. Installing..."
    curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash
fi

# Use the configured MASTER_PLAN.md path
export MASTER_PLAN_PATH="$ACTUAL_MASTER_PLAN_PATH"

cd "\$INSTALL_DIR" && npm start
LAUNCHER
```

### 6. Add Reconfigure Command

Allow users to switch projects without reinstalling:

```bash
# Add to install.sh or create a separate reconfigure.sh
if [ "$1" = "--reconfigure" ] || [ "$1" = "-r" ]; then
    echo -e "${BLUE}Reconfiguring Dev Maestro...${NC}"

    read -p "Enter path to MASTER_PLAN.md: " NEW_PATH
    if [ -f "$NEW_PATH" ]; then
        NEW_PATH=$(realpath "$NEW_PATH")
        sed -i "s|^MASTER_PLAN_PATH=.*|MASTER_PLAN_PATH=$NEW_PATH|" "$INSTALL_DIR/.env"
        echo -e "${GREEN}✓ Updated MASTER_PLAN_PATH to $NEW_PATH${NC}"

        # Offer to restart if running
        if pgrep -f "node.*server.js" > /dev/null; then
            read -p "Restart Dev Maestro to apply changes? [Y/n]: " RESTART
            if [[ ! "$RESTART" =~ ^[Nn] ]]; then
                pkill -f "node.*server.js"
                cd "$INSTALL_DIR" && npm start &
                echo -e "${GREEN}✓ Restarted${NC}"
            fi
        fi
    else
        echo -e "${RED}File not found: $NEW_PATH${NC}"
        exit 1
    fi
    exit 0
fi
```

### 7. Add Project Switching via API

Extend server.js to allow runtime project switching:

```javascript
// In server.js
app.post('/api/config/master-plan', (req, res) => {
    const { path } = req.body;

    if (!path || !fs.existsSync(path)) {
        return res.status(400).json({ error: 'Invalid path' });
    }

    // Update .env file
    const envPath = path.join(__dirname, '.env');
    let env = fs.readFileSync(envPath, 'utf8');
    env = env.replace(/^MASTER_PLAN_PATH=.*/m, `MASTER_PLAN_PATH=${path}`);
    fs.writeFileSync(envPath, env);

    // Reload in memory
    process.env.MASTER_PLAN_PATH = path;

    res.json({ success: true, path });
});
```

## Implementation Priority

1. **High**: Add `--project` and `--master-plan` argument support
2. **High**: Fix maestro.sh to use actual configured path
3. **Medium**: Add interactive project detection on fresh install
4. **Medium**: Add `--reconfigure` command
5. **Low**: Add project switching via API

## Testing Checklist

- [ ] Fresh install without arguments (should prompt or use defaults)
- [ ] Install with `--project /path/to/project`
- [ ] Install with `--master-plan /path/to/MASTER_PLAN.md`
- [ ] Update existing installation (should preserve .env settings)
- [ ] Reconfigure to different project
- [ ] maestro.sh launches with correct project
- [ ] Works when MASTER_PLAN.md is at project root
- [ ] Works when MASTER_PLAN.md is in docs/ folder
