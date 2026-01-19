#!/bin/bash
# Dev Maestro Install/Update Script
# Usage: curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash

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
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔════════════════════════════════════════════════════════╗"
echo "║           DEV MAESTRO INSTALLER / UPDATER              ║"
echo "╚════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check for required tools
command -v git >/dev/null 2>&1 || { echo -e "${RED}Error: git is required but not installed.${NC}" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo -e "${RED}Error: node is required but not installed.${NC}" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo -e "${RED}Error: npm is required but not installed.${NC}" >&2; exit 1; }

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

# Create .env if it doesn't exist
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ Created .env from template${NC}"
fi

# Project integration (if PROJECT_ROOT is set or we can detect it)
PROJECT_ROOT="${PROJECT_ROOT:-}"

# Try to detect project root from MASTER_PLAN_PATH in .env
if [ -z "$PROJECT_ROOT" ] && [ -f ".env" ]; then
    MASTER_PLAN_PATH=$(grep -E "^MASTER_PLAN_PATH=" .env | cut -d= -f2 | tr -d '"' | tr -d "'")
    if [ -n "$MASTER_PLAN_PATH" ]; then
        # Resolve to absolute path and get parent directory
        if [[ "$MASTER_PLAN_PATH" = /* ]]; then
            PROJECT_ROOT=$(dirname "$(dirname "$MASTER_PLAN_PATH")")
        fi
    fi
fi

# Create project integration files if PROJECT_ROOT is set
if [ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT" ]; then
    echo -e "${BLUE}Setting up project integration in $PROJECT_ROOT...${NC}"

    # 1. Create .dev-maestro.json marker file
    cat > "$PROJECT_ROOT/.dev-maestro.json" << EOF
{
  "installed": true,
  "installDir": "$INSTALL_DIR",
  "port": 6010,
  "startCommand": "cd $INSTALL_DIR && npm start",
  "url": "http://localhost:6010",
  "apiStatus": "http://localhost:6010/api/status"
}
EOF
    echo -e "${GREEN}✓ Created .dev-maestro.json marker${NC}"

    # 2. Create maestro.sh launcher script
    cat > "$PROJECT_ROOT/maestro.sh" << 'LAUNCHER'
#!/bin/bash
# Dev Maestro Launcher
# Starts Dev Maestro with this project's MASTER_PLAN.md

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.dev-maestro"

if [ ! -d "$INSTALL_DIR" ]; then
    echo "Dev Maestro not installed. Installing..."
    curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/install.sh | bash
fi

# Export project root so Dev Maestro knows where to find MASTER_PLAN.md
export MASTER_PLAN_PATH="$SCRIPT_DIR/docs/MASTER_PLAN.md"

cd "$INSTALL_DIR" && npm start
LAUNCHER
    chmod +x "$PROJECT_ROOT/maestro.sh"
    echo -e "${GREEN}✓ Created maestro.sh launcher${NC}"

    # 3. Append to CLAUDE.md if not already present
    CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
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

# Show version info
VERSION=$(git log -1 --format="%h %s" 2>/dev/null || echo "unknown")
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗"
echo -e "║              INSTALLATION COMPLETE                          ║"
echo -e "╠════════════════════════════════════════════════════════════╣"
echo -e "║  Location: $INSTALL_DIR"
echo -e "║  Version:  $VERSION"
echo -e "║                                                            ║"
echo -e "║  To start:                                                 ║"
echo -e "║    cd $INSTALL_DIR && npm start                            ║"
echo -e "║                                                            ║"
echo -e "║  Or add alias to ~/.bashrc:                                ║"
echo -e "║    alias dev-maestro='cd $INSTALL_DIR && npm start'        ║"
echo -e "║                                                            ║"
echo -e "║  Project integration:                                      ║"
echo -e "║    Set PROJECT_ROOT to create launcher in your project:    ║"
echo -e "║    PROJECT_ROOT=/path/to/project ./install.sh              ║"
echo -e "╚════════════════════════════════════════════════════════════╝${NC}"

# Optional: Start the server
if [ "$1" = "--start" ]; then
    echo ""
    echo -e "${BLUE}Starting Dev Maestro...${NC}"
    node server.js
fi
