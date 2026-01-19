#!/bin/bash
# Dev Maestro Install/Update Script
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash
#   curl -sSL ... | bash -s -- --project /path/to/project
#   curl -sSL ... | bash -s -- --master-plan /path/to/MASTER_PLAN.md
#   ./install.sh --reconfigure

set -e

# Configuration
REPO_URL="https://github.com/endlessblink/dev-maestro.git"
INSTALL_DIR="${DEV_MAESTRO_DIR:-$HOME/.dev-maestro}"
BRANCH="${DEV_MAESTRO_BRANCH:-main}"

# Expand ~ to $HOME if present
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Argument defaults
PROJECT_ROOT="${PROJECT_ROOT:-}"
MASTER_PLAN_PATH="${MASTER_PLAN_PATH:-}"
START_AFTER_INSTALL=false
RECONFIGURE=false
INTERACTIVE=true

# ============================================================================
# ARGUMENT PARSING
# ============================================================================
show_help() {
    echo -e "${CYAN}Dev Maestro Installer${NC}"
    echo ""
    echo "Usage: install.sh [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --project, -p PATH       Project root directory (auto-detects MASTER_PLAN.md)"
    echo "  --master-plan, -m PATH   Direct path to MASTER_PLAN.md file"
    echo "  --reconfigure, -r        Reconfigure project path for existing installation"
    echo "  --start                  Start server after installation"
    echo "  --non-interactive        Skip interactive prompts"
    echo "  --help, -h               Show this help"
    echo ""
    echo "Examples:"
    echo "  # Interactive install (prompts for project)"
    echo "  curl -sSL .../install.sh | bash"
    echo ""
    echo "  # Install with project path"
    echo "  curl -sSL .../install.sh | bash -s -- --project /path/to/myproject"
    echo ""
    echo "  # Install with direct MASTER_PLAN.md path"
    echo "  curl -sSL .../install.sh | bash -s -- -m /path/to/MASTER_PLAN.md"
    echo ""
    echo "  # Reconfigure existing installation"
    echo "  ~/.dev-maestro/install.sh --reconfigure"
    exit 0
}

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
        --reconfigure|-r)
            RECONFIGURE=true
            shift
            ;;
        --start)
            START_AFTER_INSTALL=true
            shift
            ;;
        --non-interactive)
            INTERACTIVE=false
            shift
            ;;
        --help|-h)
            show_help
            ;;
        *)
            shift
            ;;
    esac
done

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Find MASTER_PLAN.md in a project directory
find_master_plan() {
    local project_root="$1"

    # Check common locations in order of preference
    local locations=(
        "$project_root/MASTER_PLAN.md"
        "$project_root/docs/MASTER_PLAN.md"
        "$project_root/planning/MASTER_PLAN.md"
        "$project_root/.github/MASTER_PLAN.md"
        "$project_root/doc/MASTER_PLAN.md"
    )

    for loc in "${locations[@]}"; do
        if [ -f "$loc" ]; then
            echo "$loc"
            return 0
        fi
    done

    # Fallback: search for it (max depth 3)
    local found=$(find "$project_root" -maxdepth 3 -name "MASTER_PLAN.md" -type f 2>/dev/null | head -1)
    if [ -n "$found" ]; then
        echo "$found"
        return 0
    fi

    return 1
}

# Resolve path to absolute
resolve_path() {
    local input_path="$1"
    # Expand ~ to $HOME
    input_path="${input_path/#\~/$HOME}"
    # Use realpath if available, otherwise use cd trick
    if command -v realpath >/dev/null 2>&1; then
        realpath "$input_path" 2>/dev/null || echo "$input_path"
    else
        (cd "$(dirname "$input_path")" 2>/dev/null && echo "$(pwd)/$(basename "$input_path")") || echo "$input_path"
    fi
}

# Get project root from MASTER_PLAN.md path
get_project_root_from_plan() {
    local plan_path="$1"
    local plan_dir=$(dirname "$plan_path")
    local plan_dirname=$(basename "$plan_dir")

    # If in docs/, planning/, etc., go up one level
    if [[ "$plan_dirname" =~ ^(docs|doc|planning|\.github)$ ]]; then
        dirname "$plan_dir"
    else
        # MASTER_PLAN.md is at project root
        echo "$plan_dir"
    fi
}

# Update .env with MASTER_PLAN_PATH
update_env_master_plan() {
    local plan_path="$1"
    local env_file="$INSTALL_DIR/.env"

    if [ ! -f "$env_file" ]; then
        echo "MASTER_PLAN_PATH=$plan_path" > "$env_file"
    elif grep -q "^MASTER_PLAN_PATH=" "$env_file"; then
        # Update existing line
        sed -i "s|^MASTER_PLAN_PATH=.*|MASTER_PLAN_PATH=$plan_path|" "$env_file"
    else
        # Append new line
        echo "MASTER_PLAN_PATH=$plan_path" >> "$env_file"
    fi
}

# Create maestro.sh launcher in project directory
create_maestro_launcher() {
    local proj_root="$1"
    local plan_path="$2"

    # Create the launcher with the actual MASTER_PLAN_PATH embedded
    cat > "$proj_root/maestro.sh" << LAUNCHER
#!/bin/bash
# Dev Maestro Launcher with Auto-Update
# Generated for: $(basename "$proj_root")

INSTALL_DIR="\${DEV_MAESTRO_DIR:-\$HOME/.dev-maestro}"
CONFIG_FILE="\$INSTALL_DIR/local/config.json"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Install if not present
if [ ! -d "\$INSTALL_DIR" ]; then
    echo -e "\${BLUE}Dev Maestro not installed. Installing...\${NC}"
    curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash -s -- --master-plan "$plan_path"
fi

# Read autoUpdate setting from local config (default: true)
AUTO_UPDATE=true
if [ -f "\$CONFIG_FILE" ]; then
    CONFIG_AUTO=\$(grep -o '"autoUpdate"[[:space:]]*:[[:space:]]*\(true\|false\)' "\$CONFIG_FILE" 2>/dev/null | grep -o '\(true\|false\)\$')
    [ "\$CONFIG_AUTO" = "false" ] && AUTO_UPDATE=false
fi

# Auto-update check (blocking)
update_if_available() {
    cd "\$INSTALL_DIR" || return 0

    if ! timeout 10 git fetch origin main --quiet 2>/dev/null; then
        echo -e "\${YELLOW}⚠️ Could not check for updates (network unavailable)\${NC}"
        return 0
    fi

    LOCAL=\$(git rev-parse HEAD 2>/dev/null)
    REMOTE=\$(git rev-parse origin/main 2>/dev/null)

    if [ -z "\$LOCAL" ] || [ -z "\$REMOTE" ]; then
        return 0
    fi

    if [ "\$LOCAL" != "\$REMOTE" ]; then
        echo -e "\${BLUE}🔄 Dev Maestro update available...\${NC}"
        git stash --quiet 2>/dev/null || true
        if git pull origin main --quiet 2>/dev/null; then
            if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q "package.json"; then
                echo -e "\${BLUE}📦 Dependencies changed, running npm install...\${NC}"
                npm install --silent 2>/dev/null
            fi
            echo -e "\${GREEN}✅ Updated to latest version\${NC}"
        fi
    else
        echo -e "\${GREEN}✓ Dev Maestro is up to date\${NC}"
    fi
}

# Run update check unless disabled
if [[ "\$*" != *"--no-update"* ]] && [ "\$AUTO_UPDATE" = "true" ]; then
    update_if_available
fi

# Use the configured MASTER_PLAN.md path for this project
export MASTER_PLAN_PATH="$plan_path"

cd "\$INSTALL_DIR" && npm start
LAUNCHER

    chmod +x "$proj_root/maestro.sh"
    echo -e "${GREEN}✓ Created maestro.sh launcher${NC}"
}

# ============================================================================
# RECONFIGURE MODE
# ============================================================================
if [ "$RECONFIGURE" = true ]; then
    echo -e "${BLUE}"
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║           DEV MAESTRO RECONFIGURATION                  ║"
    echo "╚════════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    if [ ! -d "$INSTALL_DIR" ]; then
        echo -e "${RED}Error: Dev Maestro not installed at $INSTALL_DIR${NC}"
        echo "Run without --reconfigure to install first."
        exit 1
    fi

    # Show current configuration
    CURRENT_PATH=""
    if [ -f "$INSTALL_DIR/.env" ]; then
        CURRENT_PATH=$(grep -E "^MASTER_PLAN_PATH=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    fi

    if [ -n "$CURRENT_PATH" ]; then
        echo -e "Current project: ${CYAN}$CURRENT_PATH${NC}"
        if [ -f "$CURRENT_PATH" ]; then
            echo -e "Status: ${GREEN}✓ File exists${NC}"
        else
            echo -e "Status: ${RED}✗ File not found${NC}"
        fi
        echo ""
    fi

    # Get new path
    NEW_PLAN_PATH=""

    if [ -n "$MASTER_PLAN_PATH" ]; then
        # Path provided via argument
        NEW_PLAN_PATH=$(resolve_path "$MASTER_PLAN_PATH")
    elif [ -n "$PROJECT_ROOT" ]; then
        # Project provided, find MASTER_PLAN.md
        PROJECT_ROOT=$(resolve_path "$PROJECT_ROOT")
        NEW_PLAN_PATH=$(find_master_plan "$PROJECT_ROOT")
        if [ -z "$NEW_PLAN_PATH" ]; then
            echo -e "${RED}Error: Could not find MASTER_PLAN.md in $PROJECT_ROOT${NC}"
            exit 1
        fi
    elif [ "$INTERACTIVE" = true ]; then
        # Interactive prompt
        echo -e "${BLUE}Enter new MASTER_PLAN.md path (or project directory):${NC}"
        read -p "> " USER_INPUT

        if [ -z "$USER_INPUT" ]; then
            echo -e "${YELLOW}No input provided. Keeping current configuration.${NC}"
            exit 0
        fi

        USER_INPUT=$(resolve_path "$USER_INPUT")

        if [ -f "$USER_INPUT" ]; then
            # Direct file path
            NEW_PLAN_PATH="$USER_INPUT"
        elif [ -d "$USER_INPUT" ]; then
            # Directory - search for MASTER_PLAN.md
            NEW_PLAN_PATH=$(find_master_plan "$USER_INPUT")
            if [ -z "$NEW_PLAN_PATH" ]; then
                echo -e "${RED}Error: Could not find MASTER_PLAN.md in $USER_INPUT${NC}"
                exit 1
            fi
        else
            echo -e "${RED}Error: Path not found: $USER_INPUT${NC}"
            exit 1
        fi
    else
        echo -e "${RED}Error: No path provided and non-interactive mode enabled.${NC}"
        exit 1
    fi

    # Validate the new path
    if [ ! -f "$NEW_PLAN_PATH" ]; then
        echo -e "${RED}Error: File not found: $NEW_PLAN_PATH${NC}"
        exit 1
    fi

    # Update configuration
    update_env_master_plan "$NEW_PLAN_PATH"
    echo -e "${GREEN}✓ Updated MASTER_PLAN_PATH to: $NEW_PLAN_PATH${NC}"

    # Get project root and update launcher
    NEW_PROJECT_ROOT=$(get_project_root_from_plan "$NEW_PLAN_PATH")

    if [ -d "$NEW_PROJECT_ROOT" ]; then
        # Update or create maestro.sh in the project
        create_maestro_launcher "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH"
    fi

    # Offer to restart if running
    if pgrep -f "node.*server.js.*dev-maestro" > /dev/null 2>&1; then
        if [ "$INTERACTIVE" = true ]; then
            read -p "Dev Maestro is running. Restart to apply changes? [Y/n]: " RESTART
            if [[ ! "$RESTART" =~ ^[Nn] ]]; then
                pkill -f "node.*server.js.*dev-maestro" 2>/dev/null || true
                sleep 1
                cd "$INSTALL_DIR" && npm start &
                echo -e "${GREEN}✓ Restarted Dev Maestro${NC}"
            fi
        else
            echo -e "${YELLOW}Dev Maestro is running. Restart manually to apply changes.${NC}"
        fi
    fi

    exit 0
fi

# ============================================================================
# MAIN INSTALLATION
# ============================================================================
echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════╗"
echo "║           DEV MAESTRO INSTALLER / UPDATER              ║"
echo "╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check for required tools
command -v git >/dev/null 2>&1 || { echo -e "${RED}Error: git is required but not installed.${NC}" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo -e "${RED}Error: node is required but not installed.${NC}" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo -e "${RED}Error: npm is required but not installed.${NC}" >&2; exit 1; }

# Track if this is a fresh install
IS_FRESH_INSTALL=false

# Determine if this is an install or update
if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "${YELLOW}Existing installation found. Updating...${NC}"
    cd "$INSTALL_DIR"

    # Stash any local changes
    if ! git diff --quiet 2>/dev/null; then
        echo -e "${YELLOW}Stashing local changes...${NC}"
        git stash
    fi

    # Fetch and pull latest
    echo -e "${BLUE}Fetching latest changes from $BRANCH...${NC}"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull origin "$BRANCH"

    echo -e "${GREEN}✓ Updated to latest version${NC}"
else
    IS_FRESH_INSTALL=true
    echo -e "${BLUE}Installing Dev Maestro to $INSTALL_DIR...${NC}"

    # Clone the repository
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    echo -e "${GREEN}✓ Cloned repository${NC}"
fi

# Navigate to install directory
cd "$INSTALL_DIR"

# Install dependencies
echo -e "${BLUE}Installing dependencies...${NC}"
npm install --silent

echo -e "${GREEN}✓ Dependencies installed${NC}"

# Create local/ directory structure for user customizations
create_local_structure() {
    local LOCAL_DIR="$INSTALL_DIR/local"

    if [ ! -d "$LOCAL_DIR" ]; then
        echo -e "${BLUE}Creating local customizations directory...${NC}"
        mkdir -p "$LOCAL_DIR/icons" "$LOCAL_DIR/css" "$LOCAL_DIR/views"

        # Create default config.json
        cat > "$LOCAL_DIR/config.json" << 'LOCALCFG'
{
  "port": 6010,
  "autoUpdate": true,
  "updateBranch": "main",
  "showUpdateNotifications": true
}
LOCALCFG

        # Create .gitkeep files
        touch "$LOCAL_DIR/icons/.gitkeep" "$LOCAL_DIR/css/.gitkeep" "$LOCAL_DIR/views/.gitkeep"

        echo -e "${GREEN}✓ Created local/ customization directory${NC}"
    fi
}

# Migrate existing untracked customizations to local/
migrate_local_overrides() {
    local LOCAL_DIR="$INSTALL_DIR/local"

    # Check for untracked favicon modifications
    cd "$INSTALL_DIR"

    # Check if favicon.ico is modified (not matching origin)
    if git diff --quiet favicon.ico 2>/dev/null; then
        : # No changes
    else
        if [ -f "favicon.ico" ]; then
            # Check if it differs from the tracked version
            if git show HEAD:favicon.ico > /tmp/orig-favicon.ico 2>/dev/null; then
                if ! cmp -s "favicon.ico" "/tmp/orig-favicon.ico"; then
                    cp favicon.ico "$LOCAL_DIR/icons/"
                    git checkout favicon.ico 2>/dev/null
                    echo -e "${YELLOW}📁 Migrated custom favicon.ico to local/icons/${NC}"
                fi
                rm -f /tmp/orig-favicon.ico
            fi
        fi
    fi

    # Similar check for favicon.svg
    if git diff --quiet favicon.svg 2>/dev/null; then
        : # No changes
    else
        if [ -f "favicon.svg" ]; then
            if git show HEAD:favicon.svg > /tmp/orig-favicon.svg 2>/dev/null; then
                if ! cmp -s "favicon.svg" "/tmp/orig-favicon.svg"; then
                    cp favicon.svg "$LOCAL_DIR/icons/"
                    git checkout favicon.svg 2>/dev/null
                    echo -e "${YELLOW}📁 Migrated custom favicon.svg to local/icons/${NC}"
                fi
                rm -f /tmp/orig-favicon.svg
            fi
        fi
    fi
}

# Create local structure
create_local_structure

# Migrate existing customizations (only on update)
if [ "$IS_FRESH_INSTALL" = false ]; then
    migrate_local_overrides
fi

# Create .env if it doesn't exist
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ Created .env from template${NC}"
fi

# ============================================================================
# PROJECT SETUP
# ============================================================================

# Determine MASTER_PLAN_PATH from arguments or interactive prompts
FINAL_PLAN_PATH=""
FINAL_PROJECT_ROOT=""

# Priority 1: Direct MASTER_PLAN_PATH argument
if [ -n "$MASTER_PLAN_PATH" ]; then
    FINAL_PLAN_PATH=$(resolve_path "$MASTER_PLAN_PATH")
    if [ ! -f "$FINAL_PLAN_PATH" ]; then
        echo -e "${RED}Warning: MASTER_PLAN.md not found at $FINAL_PLAN_PATH${NC}"
        FINAL_PLAN_PATH=""
    else
        FINAL_PROJECT_ROOT=$(get_project_root_from_plan "$FINAL_PLAN_PATH")
    fi
fi

# Priority 2: PROJECT_ROOT argument (search for MASTER_PLAN.md)
if [ -z "$FINAL_PLAN_PATH" ] && [ -n "$PROJECT_ROOT" ]; then
    PROJECT_ROOT=$(resolve_path "$PROJECT_ROOT")
    if [ -d "$PROJECT_ROOT" ]; then
        FINAL_PLAN_PATH=$(find_master_plan "$PROJECT_ROOT")
        if [ -n "$FINAL_PLAN_PATH" ]; then
            FINAL_PROJECT_ROOT="$PROJECT_ROOT"
            echo -e "${GREEN}✓ Found MASTER_PLAN.md at: $FINAL_PLAN_PATH${NC}"
        else
            echo -e "${YELLOW}Warning: Could not find MASTER_PLAN.md in $PROJECT_ROOT${NC}"
        fi
    else
        echo -e "${RED}Warning: Project directory not found: $PROJECT_ROOT${NC}"
    fi
fi

# Priority 3: Try to detect from existing .env
if [ -z "$FINAL_PLAN_PATH" ] && [ -f ".env" ]; then
    EXISTING_PATH=$(grep -E "^MASTER_PLAN_PATH=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    if [ -n "$EXISTING_PATH" ] && [ -f "$EXISTING_PATH" ]; then
        FINAL_PLAN_PATH="$EXISTING_PATH"
        FINAL_PROJECT_ROOT=$(get_project_root_from_plan "$FINAL_PLAN_PATH")
        echo -e "${CYAN}Using existing project: $FINAL_PLAN_PATH${NC}"
    fi
fi

# Priority 4: Try to auto-detect from current working directory (where install was run)
if [ -z "$FINAL_PLAN_PATH" ]; then
    # Check if we were called from a project directory
    CALLER_DIR="${OLDPWD:-$(pwd)}"
    if [ "$CALLER_DIR" != "$INSTALL_DIR" ]; then
        DETECTED_PATH=$(find_master_plan "$CALLER_DIR")
        if [ -n "$DETECTED_PATH" ]; then
            if [ "$INTERACTIVE" = true ]; then
                echo -e "${CYAN}Detected MASTER_PLAN.md at: $DETECTED_PATH${NC}"
                read -p "Use this project? [Y/n]: " USE_DETECTED
                if [[ ! "$USE_DETECTED" =~ ^[Nn] ]]; then
                    FINAL_PLAN_PATH="$DETECTED_PATH"
                    FINAL_PROJECT_ROOT="$CALLER_DIR"
                fi
            else
                FINAL_PLAN_PATH="$DETECTED_PATH"
                FINAL_PROJECT_ROOT="$CALLER_DIR"
            fi
        fi
    fi
fi

# Priority 5: Interactive prompt for fresh installs
if [ -z "$FINAL_PLAN_PATH" ] && [ "$IS_FRESH_INSTALL" = true ] && [ "$INTERACTIVE" = true ]; then
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}                    PROJECT SETUP                          ${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Enter the path to your project directory or MASTER_PLAN.md file."
    echo "Press Enter to skip and configure later with: install.sh --reconfigure"
    echo ""
    read -p "Project path: " USER_INPUT

    if [ -n "$USER_INPUT" ]; then
        USER_INPUT=$(resolve_path "$USER_INPUT")

        if [ -f "$USER_INPUT" ]; then
            # Direct file path provided
            FINAL_PLAN_PATH="$USER_INPUT"
            FINAL_PROJECT_ROOT=$(get_project_root_from_plan "$FINAL_PLAN_PATH")
        elif [ -d "$USER_INPUT" ]; then
            # Directory provided - search for MASTER_PLAN.md
            FINAL_PLAN_PATH=$(find_master_plan "$USER_INPUT")
            if [ -n "$FINAL_PLAN_PATH" ]; then
                FINAL_PROJECT_ROOT="$USER_INPUT"
                echo -e "${GREEN}✓ Found MASTER_PLAN.md at: $FINAL_PLAN_PATH${NC}"
            else
                echo -e "${YELLOW}Could not find MASTER_PLAN.md in $USER_INPUT${NC}"
                echo "You can configure later with: ~/.dev-maestro/install.sh --reconfigure"
            fi
        else
            echo -e "${YELLOW}Path not found: $USER_INPUT${NC}"
            echo "You can configure later with: ~/.dev-maestro/install.sh --reconfigure"
        fi
    fi
fi

# Apply the configuration if we have a valid path
if [ -n "$FINAL_PLAN_PATH" ]; then
    update_env_master_plan "$FINAL_PLAN_PATH"
    echo -e "${GREEN}✓ Configured MASTER_PLAN_PATH: $FINAL_PLAN_PATH${NC}"
fi

# Create project integration files if we have a project root
if [ -n "$FINAL_PROJECT_ROOT" ] && [ -d "$FINAL_PROJECT_ROOT" ]; then
    echo -e "${BLUE}Setting up project integration in $FINAL_PROJECT_ROOT...${NC}"

    # 1. Create .dev-maestro.json marker file
    cat > "$FINAL_PROJECT_ROOT/.dev-maestro.json" << EOF
{
  "installed": true,
  "installDir": "$INSTALL_DIR",
  "port": 6010,
  "masterPlanPath": "$FINAL_PLAN_PATH",
  "startCommand": "cd $INSTALL_DIR && npm start",
  "url": "http://localhost:6010",
  "apiStatus": "http://localhost:6010/api/status"
}
EOF
    echo -e "${GREEN}✓ Created .dev-maestro.json marker${NC}"

    # 2. Create maestro.sh launcher script
    create_maestro_launcher "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH"

    # 3. Append to CLAUDE.md if not already present
    CLAUDE_MD="$FINAL_PROJECT_ROOT/CLAUDE.md"
    if [ -f "$CLAUDE_MD" ]; then
        if ! grep -q "## Dev Maestro" "$CLAUDE_MD"; then
            cat >> "$CLAUDE_MD" << 'CLAUDEMD'

## Dev Maestro

**AI Agent Orchestration Platform** - Kanban board for MASTER_PLAN.md tasks.

| Item | Value |
|------|-------|
| URL | http://localhost:6010 |
| Start | `./maestro.sh` or `cd ~/.dev-maestro && npm start` |
| Status API | `curl -s localhost:6010/api/status` |

**Views**: Kanban, Orchestrator, Skills, Docs, Stats, Timeline, Health

To check if running: `curl -s localhost:6010/api/status | jq .running`
CLAUDEMD
            echo -e "${GREEN}✓ Added Dev Maestro section to CLAUDE.md${NC}"
        else
            echo -e "${YELLOW}Dev Maestro section already in CLAUDE.md${NC}"
        fi
    fi
fi

# ============================================================================
# COMPLETION
# ============================================================================

VERSION=$(git log -1 --format="%h %s" 2>/dev/null || echo "unknown")
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗"
echo -e "║              INSTALLATION COMPLETE                          ║"
echo -e "╠════════════════════════════════════════════════════════════╣"
echo -e "║  Location: $INSTALL_DIR"
echo -e "║  Version:  $VERSION"
if [ -n "$FINAL_PLAN_PATH" ]; then
echo -e "║  Project:  $FINAL_PLAN_PATH"
fi
echo -e "║                                                            ║"
echo -e "║  To start:                                                 ║"
if [ -n "$FINAL_PROJECT_ROOT" ]; then
echo -e "║    cd $FINAL_PROJECT_ROOT && ./maestro.sh"
else
echo -e "║    cd $INSTALL_DIR && npm start"
fi
echo -e "║                                                            ║"
echo -e "║  To reconfigure project:                                   ║"
echo -e "║    $INSTALL_DIR/install.sh --reconfigure                   ║"
echo -e "╚════════════════════════════════════════════════════════════╝${NC}"

# Optional: Start the server
if [ "$START_AFTER_INSTALL" = true ]; then
    echo ""
    echo -e "${BLUE}Starting Dev Maestro...${NC}"
    node server.js
fi
