#!/bin/bash
# Dev Maestro Modular Install/Update Script
#
# Usage:
#   # Full install (interactive — prompts for modules)
#   dev-maestro install /path/to/project
#
#   # Non-interactive with specific modules
#   dev-maestro install /path/to/project --modules=dashboard,skills,tui
#
#   # Reconfigure existing project
#   dev-maestro install /path/to/project --reconfigure
#
#   # Legacy usage (still supported)
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
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Argument defaults
PROJECT_ROOT="${PROJECT_ROOT:-}"
MASTER_PLAN_PATH="${MASTER_PLAN_PATH:-}"
START_AFTER_INSTALL=false
RECONFIGURE=false
INTERACTIVE=true
SELECTED_MODULES=""

# Available modules (core is always installed)
ALL_MODULES="dashboard skills tui beads health"

# ============================================================================
# ARGUMENT PARSING
# ============================================================================
show_help() {
    echo -e "${CYAN}Dev Maestro Modular Installer${NC}"
    echo ""
    echo "Usage: install.sh [OPTIONS] [PROJECT_PATH]"
    echo ""
    echo "Options:"
    echo "  --project, -p PATH       Project root directory (auto-detects MASTER_PLAN.md)"
    echo "  --master-plan, -m PATH   Direct path to MASTER_PLAN.md file"
    echo "  --modules MODULES        Comma-separated list of modules to install"
    echo "                           Available: dashboard, skills, tui, beads, health"
    echo "                           (core is always installed)"
    echo "  --reconfigure, -r        Reconfigure project path for existing installation"
    echo "  --start                  Start server after installation"
    echo "  --non-interactive        Skip interactive prompts"
    echo "  --help, -h               Show this help"
    echo ""
    echo "Examples:"
    echo "  # Interactive install (prompts for project and modules)"
    echo "  ./install.sh"
    echo ""
    echo "  # Install with project path (interactive module selection)"
    echo "  ./install.sh /path/to/myproject"
    echo ""
    echo "  # Install with specific modules"
    echo "  ./install.sh /path/to/myproject --modules=dashboard,skills,tui"
    echo ""
    echo "  # Install with direct MASTER_PLAN.md path"
    echo "  ./install.sh -m /path/to/MASTER_PLAN.md --modules=dashboard,skills"
    echo ""
    echo "  # Reconfigure existing installation"
    echo "  ./install.sh --reconfigure"
    echo ""
    echo "Modules:"
    echo "  core       Creates .dev-maestro.json, registers in projects.json,"
    echo "             creates/finds MASTER_PLAN.md (always installed)"
    echo "  dashboard  Configures .env so dashboard can serve this project"
    echo "  skills     Registers master-plan plugin in Claude Code,"
    echo "             adds CLAUDE_INSTRUCTIONS.md to project"
    echo "  tui        Adds maestro CLI wrapper to project"
    echo "  beads      Installs bd binary (if missing), initializes .beads/ in project"
    echo "  health     Configures health scanner for project's tech stack"
    exit 0
}

# Parse arguments — support positional project path
POSITIONAL_ARGS=()
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
        --modules|--modules=*)
            if [[ "$1" == --modules=* ]]; then
                SELECTED_MODULES="${1#--modules=}"
                shift
            else
                SELECTED_MODULES="$2"
                shift 2
            fi
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
        -*)
            echo -e "${YELLOW}Unknown option: $1${NC}" >&2
            shift
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# Use first positional arg as project path if --project not given
if [ -z "$PROJECT_ROOT" ] && [ ${#POSITIONAL_ARGS[@]} -gt 0 ]; then
    PROJECT_ROOT="${POSITIONAL_ARGS[0]}"
fi

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

# Get project name from path
get_project_name() {
    local project_root="$1"
    basename "$project_root"
}

# Register project in projects.json
register_project() {
    local project_name="$1"
    local project_root="$2"
    local plan_path="$3"
    local modules_json="$4"  # JSON array string like ["core","dashboard"]
    local projects_file="$INSTALL_DIR/projects.json"
    local today=$(date +%Y-%m-%d)

    if [ ! -f "$projects_file" ]; then
        cat > "$projects_file" << EOF
{
  "projects": []
}
EOF
    fi

    # Check if project already registered (by root path)
    if grep -q "\"root\": \"$project_root\"" "$projects_file" 2>/dev/null; then
        # Update existing entry using a temp file approach
        local tmp_file=$(mktemp)
        node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('$projects_file', 'utf8'));
const idx = data.projects.findIndex(p => p.root === '$project_root');
if (idx >= 0) {
    data.projects[idx].masterPlan = '$plan_path';
    data.projects[idx].modules = $modules_json;
    data.projects[idx].name = '$project_name';
}
fs.writeFileSync('$tmp_file', JSON.stringify(data, null, 2) + '\n');
" 2>/dev/null && mv "$tmp_file" "$projects_file"
        echo -e "${GREEN}  Updated project in projects.json${NC}"
    else
        # Add new entry
        local tmp_file=$(mktemp)
        node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('$projects_file', 'utf8'));
data.projects.push({
    name: '$project_name',
    root: '$project_root',
    masterPlan: '$plan_path',
    modules: $modules_json,
    addedAt: '$today'
});
fs.writeFileSync('$tmp_file', JSON.stringify(data, null, 2) + '\n');
" 2>/dev/null && mv "$tmp_file" "$projects_file"
        echo -e "${GREEN}  Registered project in projects.json${NC}"
    fi
}

# Interactive module selection checklist
select_modules_interactive() {
    echo ""
    echo -e "${BLUE}Select modules to install:${NC}"
    echo -e "${DIM}(core is always installed)${NC}"
    echo ""

    local modules=("dashboard" "skills" "tui" "beads" "health")
    local descriptions=(
        "Configures .env so dashboard can serve this project"
        "Registers master-plan plugin in Claude Code, adds CLAUDE_INSTRUCTIONS.md"
        "Adds maestro CLI wrapper to project"
        "Installs bd binary (if missing), initializes .beads/ in project"
        "Configures health scanner for project's tech stack"
    )
    local defaults=("y" "y" "y" "n" "n")
    local selected=()

    for i in "${!modules[@]}"; do
        local mod="${modules[$i]}"
        local desc="${descriptions[$i]}"
        local default="${defaults[$i]}"
        local prompt_default="Y/n"
        [ "$default" = "n" ] && prompt_default="y/N"

        echo -e "  ${CYAN}${mod}${NC}: ${desc}"
        read -p "    Install ${mod}? [${prompt_default}]: " answer
        answer="${answer:-$default}"

        if [[ "$answer" =~ ^[Yy] ]]; then
            selected+=("$mod")
        fi
    done

    echo ""
    SELECTED_MODULES=$(IFS=,; echo "${selected[*]}")
}

# Parse comma-separated modules into array
parse_modules() {
    local input="$1"
    # Always include core
    local result=("core")

    if [ -n "$input" ]; then
        IFS=',' read -ra mods <<< "$input"
        for mod in "${mods[@]}"; do
            mod=$(echo "$mod" | tr -d ' ')
            # Skip if core (already added) or empty
            [ "$mod" = "core" ] || [ -z "$mod" ] && continue
            # Validate module name
            if echo "$ALL_MODULES" | grep -qw "$mod"; then
                result+=("$mod")
            else
                echo -e "${YELLOW}Warning: Unknown module '$mod', skipping${NC}"
            fi
        done
    fi

    echo "${result[@]}"
}

# Check if a module is in the selected list
has_module() {
    local target="$1"
    shift
    local modules=("$@")
    for mod in "${modules[@]}"; do
        [ "$mod" = "$target" ] && return 0
    done
    return 1
}

# ============================================================================
# MODULE FUNCTIONS
# ============================================================================

# --- CORE MODULE (always runs) ---
install_core() {
    local project_root="$1"
    local plan_path="$2"

    echo -e "${BLUE}[core] Setting up project integration...${NC}"

    # 1. Create .dev-maestro.json marker file
    cat > "$project_root/.dev-maestro.json" << EOF
{
  "installed": true,
  "installDir": "$INSTALL_DIR",
  "port": 6010,
  "masterPlanPath": "$plan_path",
  "startCommand": "cd $INSTALL_DIR && npm start",
  "url": "http://localhost:6010",
  "apiStatus": "http://localhost:6010/api/status"
}
EOF
    echo -e "${GREEN}  Created .dev-maestro.json marker${NC}"

    # 2. Create MASTER_PLAN.md if it doesn't exist
    if [ ! -f "$plan_path" ]; then
        local plan_dir=$(dirname "$plan_path")
        mkdir -p "$plan_dir"
        local project_name=$(get_project_name "$project_root")
        cat > "$plan_path" << PLAN
# MASTER PLAN: ${project_name}

## Backlog

### MP-001 Initial Setup
- **Status**: TODO
- **Complexity**: S
- **Description**: Set up the project structure and initial configuration.
PLAN
        echo -e "${GREEN}  Created initial MASTER_PLAN.md${NC}"
    fi

    # 3. Register in projects.json (done after all modules selected)
    echo -e "${GREEN}  [core] Complete${NC}"
}

# --- DASHBOARD MODULE ---
install_dashboard() {
    local project_root="$1"
    local plan_path="$2"

    echo -e "${BLUE}[dashboard] Configuring dashboard...${NC}"

    # Update .env with MASTER_PLAN_PATH
    update_env_master_plan "$plan_path"
    echo -e "${GREEN}  Configured MASTER_PLAN_PATH in .env${NC}"

    echo -e "${GREEN}  [dashboard] Complete${NC}"
}

# --- SKILLS MODULE ---
install_skills() {
    local project_root="$1"
    local plan_path="$2"

    echo -e "${BLUE}[skills] Setting up Claude Code integration...${NC}"

    # 1. Append to CLAUDE.md if not already present
    local claude_md="$project_root/CLAUDE.md"
    if [ -f "$claude_md" ]; then
        if ! grep -q "## Dev Maestro" "$claude_md"; then
            cat >> "$claude_md" << 'CLAUDEMD'

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
            echo -e "${GREEN}  Added Dev Maestro section to CLAUDE.md${NC}"
        else
            echo -e "${DIM}  Dev Maestro section already in CLAUDE.md${NC}"
        fi
    fi

    # 2. Register master-plan plugin in Claude Code settings if available
    local claude_settings="$HOME/.claude/settings.json"
    if [ -f "$claude_settings" ]; then
        # Check if master-plan MCP is already registered
        if ! grep -q "master-plan" "$claude_settings" 2>/dev/null; then
            echo -e "${DIM}  Note: Add master-plan MCP server manually to Claude Code settings${NC}"
        else
            echo -e "${DIM}  master-plan MCP already registered${NC}"
        fi
    fi

    echo -e "${GREEN}  [skills] Complete${NC}"
}

# --- TUI MODULE ---
install_tui() {
    local project_root="$1"
    local plan_path="$2"

    echo -e "${BLUE}[tui] Adding maestro CLI wrapper...${NC}"

    # Create maestro.sh launcher in project directory
    cat > "$project_root/maestro.sh" << LAUNCHER
#!/bin/bash
# Dev Maestro Launcher with Auto-Update
# Generated for: $(basename "$project_root")

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
        echo -e "\${YELLOW}Could not check for updates (network unavailable)\${NC}"
        return 0
    fi

    LOCAL=\$(git rev-parse HEAD 2>/dev/null)
    REMOTE=\$(git rev-parse origin/main 2>/dev/null)

    if [ -z "\$LOCAL" ] || [ -z "\$REMOTE" ]; then
        return 0
    fi

    if [ "\$LOCAL" != "\$REMOTE" ]; then
        echo -e "\${BLUE}Dev Maestro update available...\${NC}"
        git stash --quiet 2>/dev/null || true
        if git pull origin main --quiet 2>/dev/null; then
            if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q "package.json"; then
                echo -e "\${BLUE}Dependencies changed, running npm install...\${NC}"
                npm install --silent 2>/dev/null
            fi
            echo -e "\${GREEN}Updated to latest version\${NC}"
        fi
    else
        echo -e "\${GREEN}Dev Maestro is up to date\${NC}"
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

    chmod +x "$project_root/maestro.sh"
    echo -e "${GREEN}  Created maestro.sh launcher${NC}"

    echo -e "${GREEN}  [tui] Complete${NC}"
}

# --- BEADS MODULE ---
install_beads() {
    local project_root="$1"
    local plan_path="$2"

    echo -e "${BLUE}[beads] Setting up beads orchestration...${NC}"

    # 1. Install bd binary if not available
    if command -v bd &>/dev/null; then
        echo -e "${DIM}  bd binary already installed${NC}"
    else
        echo -e "${BLUE}  Installing bd binary...${NC}"
        local installed=false

        if command -v npm &>/dev/null; then
            if npm install -g @beads/bd 2>/dev/null; then
                installed=true
            fi
        fi

        if [ "$installed" = false ] && command -v brew &>/dev/null; then
            if brew install beads 2>/dev/null; then
                installed=true
            fi
        fi

        if [ "$installed" = false ] && command -v go &>/dev/null; then
            if go install github.com/steveyegge/beads/cmd/bd@latest 2>/dev/null; then
                installed=true
            fi
        fi

        if [ "$installed" = false ]; then
            echo -e "${YELLOW}  Warning: Could not install beads. Install manually or skip this module.${NC}"
        else
            echo -e "${GREEN}  Installed bd binary${NC}"
        fi
    fi

    # 2. Initialize .beads/ directory in project
    local beads_dir="$project_root/.beads"
    if [ ! -d "$beads_dir" ]; then
        mkdir -p "$beads_dir"
        cat > "$beads_dir/config.json" << BEADSCFG
{
  "project": "$(get_project_name "$project_root")",
  "masterPlan": "$plan_path"
}
BEADSCFG
        echo -e "${GREEN}  Initialized .beads/ directory${NC}"
    else
        echo -e "${DIM}  .beads/ directory already exists${NC}"
    fi

    echo -e "${GREEN}  [beads] Complete${NC}"
}

# --- HEALTH MODULE ---
install_health() {
    local project_root="$1"
    local plan_path="$2"

    echo -e "${BLUE}[health] Configuring health scanner...${NC}"

    # Auto-detect tech stack
    local stack=()

    [ -f "$project_root/package.json" ] && stack+=("node")
    [ -f "$project_root/tsconfig.json" ] && stack+=("typescript")
    [ -f "$project_root/requirements.txt" ] || [ -f "$project_root/pyproject.toml" ] && stack+=("python")
    [ -f "$project_root/go.mod" ] && stack+=("go")
    [ -f "$project_root/Cargo.toml" ] && stack+=("rust")
    [ -f "$project_root/pom.xml" ] || [ -f "$project_root/build.gradle" ] && stack+=("java")

    if [ ${#stack[@]} -eq 0 ]; then
        stack+=("generic")
    fi

    # Write health config to .dev-maestro.json (update existing)
    local marker="$project_root/.dev-maestro.json"
    if [ -f "$marker" ]; then
        local stack_json=$(printf '%s\n' "${stack[@]}" | jq -R . | jq -s . 2>/dev/null || echo '["generic"]')
        local tmp_file=$(mktemp)
        node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('$marker', 'utf8'));
data.healthScanner = { techStack: $stack_json, enabled: true };
fs.writeFileSync('$tmp_file', JSON.stringify(data, null, 2) + '\n');
" 2>/dev/null && mv "$tmp_file" "$marker"
    fi

    echo -e "${GREEN}  Detected tech stack: ${stack[*]}${NC}"
    echo -e "${GREEN}  [health] Complete${NC}"
}

# ============================================================================
# LOCAL STRUCTURE & MIGRATION (from original install.sh)
# ============================================================================

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

        echo -e "${GREEN}  Created local/ customization directory${NC}"
    fi
}

# Migrate existing untracked customizations to local/
migrate_local_overrides() {
    local LOCAL_DIR="$INSTALL_DIR/local"

    cd "$INSTALL_DIR"

    # Check if favicon.ico is modified (not matching origin)
    if ! git diff --quiet favicon.ico 2>/dev/null; then
        if [ -f "favicon.ico" ]; then
            if git show HEAD:favicon.ico > /tmp/orig-favicon.ico 2>/dev/null; then
                if ! cmp -s "favicon.ico" "/tmp/orig-favicon.ico"; then
                    cp favicon.ico "$LOCAL_DIR/icons/"
                    git checkout favicon.ico 2>/dev/null
                    echo -e "${YELLOW}  Migrated custom favicon.ico to local/icons/${NC}"
                fi
                rm -f /tmp/orig-favicon.ico
            fi
        fi
    fi

    # Similar check for favicon.svg
    if ! git diff --quiet favicon.svg 2>/dev/null; then
        if [ -f "favicon.svg" ]; then
            if git show HEAD:favicon.svg > /tmp/orig-favicon.svg 2>/dev/null; then
                if ! cmp -s "favicon.svg" "/tmp/orig-favicon.svg"; then
                    cp favicon.svg "$LOCAL_DIR/icons/"
                    git checkout favicon.svg 2>/dev/null
                    echo -e "${YELLOW}  Migrated custom favicon.svg to local/icons/${NC}"
                fi
                rm -f /tmp/orig-favicon.svg
            fi
        fi
    fi
}

# ============================================================================
# RECONFIGURE MODE
# ============================================================================
if [ "$RECONFIGURE" = true ]; then
    echo -e "${BLUE}"
    echo "============================================================"
    echo "           DEV MAESTRO RECONFIGURATION"
    echo "============================================================"
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
            echo -e "Status: ${GREEN}File exists${NC}"
        else
            echo -e "Status: ${RED}File not found${NC}"
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
            NEW_PLAN_PATH="$USER_INPUT"
        elif [ -d "$USER_INPUT" ]; then
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
    echo -e "${GREEN}Updated MASTER_PLAN_PATH to: $NEW_PLAN_PATH${NC}"

    # Get project root and update launcher
    NEW_PROJECT_ROOT=$(get_project_root_from_plan "$NEW_PLAN_PATH")

    if [ -d "$NEW_PROJECT_ROOT" ]; then
        # Re-run module selection for reconfigure
        if [ -z "$SELECTED_MODULES" ] && [ "$INTERACTIVE" = true ]; then
            select_modules_interactive
        fi
        local modules_arr=($(parse_modules "$SELECTED_MODULES"))

        # Run selected modules
        install_core "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH"

        has_module "dashboard" "${modules_arr[@]}" && install_dashboard "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH"
        has_module "skills" "${modules_arr[@]}" && install_skills "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH"
        has_module "tui" "${modules_arr[@]}" && install_tui "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH"
        has_module "beads" "${modules_arr[@]}" && install_beads "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH"
        has_module "health" "${modules_arr[@]}" && install_health "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH"

        # Build modules JSON and register
        local modules_json=$(printf '%s\n' "${modules_arr[@]}" | jq -R . | jq -s . 2>/dev/null || echo '["core"]')
        register_project "$(get_project_name "$NEW_PROJECT_ROOT")" "$NEW_PROJECT_ROOT" "$NEW_PLAN_PATH" "$modules_json"
    fi

    # Offer to restart if running
    if pgrep -f "node.*server.js.*dev-maestro" > /dev/null 2>&1; then
        if [ "$INTERACTIVE" = true ]; then
            read -p "Dev Maestro is running. Restart to apply changes? [Y/n]: " RESTART
            if [[ ! "$RESTART" =~ ^[Nn] ]]; then
                pkill -f "node.*server.js.*dev-maestro" 2>/dev/null || true
                sleep 1
                cd "$INSTALL_DIR" && npm start &
                echo -e "${GREEN}Restarted Dev Maestro${NC}"
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
echo "============================================================"
echo "           DEV MAESTRO INSTALLER / UPDATER"
echo "============================================================"
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

    echo -e "${GREEN}Updated to latest version${NC}"
else
    IS_FRESH_INSTALL=true
    echo -e "${BLUE}Installing Dev Maestro to $INSTALL_DIR...${NC}"

    # Clone the repository
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    echo -e "${GREEN}Cloned repository${NC}"
fi

# Navigate to install directory
cd "$INSTALL_DIR"

# Install dependencies
echo -e "${BLUE}Installing dependencies...${NC}"
npm install --silent

echo -e "${GREEN}Dependencies installed${NC}"

# Create local structure
create_local_structure

# Migrate existing customizations (only on update)
if [ "$IS_FRESH_INSTALL" = false ]; then
    migrate_local_overrides
fi

# Create .env if it doesn't exist
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo -e "${GREEN}Created .env from template${NC}"
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
            echo -e "${GREEN}Found MASTER_PLAN.md at: $FINAL_PLAN_PATH${NC}"
        else
            echo -e "${YELLOW}Warning: Could not find MASTER_PLAN.md in $PROJECT_ROOT${NC}"
            # Will create one in install_core
            FINAL_PLAN_PATH="$PROJECT_ROOT/MASTER_PLAN.md"
            FINAL_PROJECT_ROOT="$PROJECT_ROOT"
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
    echo -e "${BLUE}------------------------------------------------------------${NC}"
    echo -e "${BLUE}                    PROJECT SETUP                          ${NC}"
    echo -e "${BLUE}------------------------------------------------------------${NC}"
    echo ""
    echo "Enter the path to your project directory or MASTER_PLAN.md file."
    echo "Press Enter to skip and configure later with: install.sh --reconfigure"
    echo ""
    read -p "Project path: " USER_INPUT

    if [ -n "$USER_INPUT" ]; then
        USER_INPUT=$(resolve_path "$USER_INPUT")

        if [ -f "$USER_INPUT" ]; then
            FINAL_PLAN_PATH="$USER_INPUT"
            FINAL_PROJECT_ROOT=$(get_project_root_from_plan "$FINAL_PLAN_PATH")
        elif [ -d "$USER_INPUT" ]; then
            FINAL_PLAN_PATH=$(find_master_plan "$USER_INPUT")
            if [ -n "$FINAL_PLAN_PATH" ]; then
                FINAL_PROJECT_ROOT="$USER_INPUT"
                echo -e "${GREEN}Found MASTER_PLAN.md at: $FINAL_PLAN_PATH${NC}"
            else
                echo -e "${YELLOW}Could not find MASTER_PLAN.md in $USER_INPUT${NC}"
                echo "Creating a new MASTER_PLAN.md..."
                FINAL_PLAN_PATH="$USER_INPUT/MASTER_PLAN.md"
                FINAL_PROJECT_ROOT="$USER_INPUT"
            fi
        else
            echo -e "${YELLOW}Path not found: $USER_INPUT${NC}"
            echo "You can configure later with: ~/.dev-maestro/install.sh --reconfigure"
        fi
    fi
fi

# ============================================================================
# RUN MODULES
# ============================================================================

if [ -n "$FINAL_PLAN_PATH" ] && [ -n "$FINAL_PROJECT_ROOT" ] && [ -d "$FINAL_PROJECT_ROOT" ]; then
    echo ""
    echo -e "${BLUE}------------------------------------------------------------${NC}"
    echo -e "${BLUE}                  MODULE INSTALLATION                       ${NC}"
    echo -e "${BLUE}------------------------------------------------------------${NC}"
    echo -e "Project: ${CYAN}$FINAL_PROJECT_ROOT${NC}"
    echo ""

    # Module selection: interactive if not specified
    if [ -z "$SELECTED_MODULES" ] && [ "$INTERACTIVE" = true ]; then
        select_modules_interactive
    fi

    # Parse modules (always includes core)
    MODULES_ARR=($(parse_modules "$SELECTED_MODULES"))

    echo -e "${BLUE}Installing modules: ${CYAN}${MODULES_ARR[*]}${NC}"
    echo ""

    # Run core (always)
    install_core "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH"

    # Run selected optional modules
    has_module "dashboard" "${MODULES_ARR[@]}" && install_dashboard "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH"
    has_module "skills" "${MODULES_ARR[@]}" && install_skills "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH"
    has_module "tui" "${MODULES_ARR[@]}" && install_tui "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH"
    has_module "beads" "${MODULES_ARR[@]}" && install_beads "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH"
    has_module "health" "${MODULES_ARR[@]}" && install_health "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH"

    # Register project in projects.json
    MODULES_JSON=$(printf '%s\n' "${MODULES_ARR[@]}" | jq -R . | jq -s . 2>/dev/null || echo '["core"]')
    register_project "$(get_project_name "$FINAL_PROJECT_ROOT")" "$FINAL_PROJECT_ROOT" "$FINAL_PLAN_PATH" "$MODULES_JSON"

elif [ -n "$FINAL_PLAN_PATH" ]; then
    # No project root but have a plan path — just configure .env
    update_env_master_plan "$FINAL_PLAN_PATH"
    echo -e "${GREEN}Configured MASTER_PLAN_PATH: $FINAL_PLAN_PATH${NC}"
fi

# ============================================================================
# COMPLETION
# ============================================================================

VERSION=$(git log -1 --format="%h %s" 2>/dev/null || echo "unknown")
echo ""
echo -e "${GREEN}============================================================"
echo -e "              INSTALLATION COMPLETE"
echo -e "============================================================"
echo -e "  Location: $INSTALL_DIR"
echo -e "  Version:  $VERSION"
if [ -n "$FINAL_PLAN_PATH" ]; then
echo -e "  Project:  $FINAL_PLAN_PATH"
fi
if [ ${#MODULES_ARR[@]:-0} -gt 0 ]; then
echo -e "  Modules:  ${MODULES_ARR[*]}"
fi
echo -e ""
echo -e "  To start:"
if [ -n "$FINAL_PROJECT_ROOT" ] && [ -f "$FINAL_PROJECT_ROOT/maestro.sh" ]; then
echo -e "    cd $FINAL_PROJECT_ROOT && ./maestro.sh"
else
echo -e "    cd $INSTALL_DIR && npm start"
fi
echo -e ""
echo -e "  To reconfigure project:"
echo -e "    $INSTALL_DIR/install.sh --reconfigure"
echo -e "============================================================${NC}"

# Optional: Start the server
if [ "$START_AFTER_INSTALL" = true ]; then
    echo ""
    echo -e "${BLUE}Starting Dev Maestro...${NC}"
    node server.js
fi
