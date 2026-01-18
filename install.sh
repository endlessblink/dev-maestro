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

# Show version info
VERSION=$(git log -1 --format="%h %s" 2>/dev/null || echo "unknown")
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════╗"
echo -e "║           INSTALLATION COMPLETE                         ║"
echo -e "╠════════════════════════════════════════════════════════╣"
echo -e "║  Location: $INSTALL_DIR"
echo -e "║  Version:  $VERSION"
echo -e "║                                                        ║"
echo -e "║  To start:                                             ║"
echo -e "║    cd $INSTALL_DIR && npm start"
echo -e "║                                                        ║"
echo -e "║  Or add alias to ~/.bashrc:                            ║"
echo -e "║    alias dev-maestro='node $INSTALL_DIR/server.js'"
echo -e "╚════════════════════════════════════════════════════════╝${NC}"

# Optional: Start the server
if [ "$1" = "--start" ]; then
    echo ""
    echo -e "${BLUE}Starting Dev Maestro...${NC}"
    node server.js
fi
