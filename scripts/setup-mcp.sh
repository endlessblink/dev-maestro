#!/bin/bash
# Setup Dev Maestro MCP integration for a project
# Usage: ./setup-mcp.sh /path/to/project

set -e

PROJECT_ROOT="${1:-$PWD}"
INSTALL_DIR="$HOME/.dev-maestro"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ ! -d "$PROJECT_ROOT" ]; then
    echo -e "${YELLOW}Error: Project directory not found: $PROJECT_ROOT${NC}"
    exit 1
fi

echo -e "${BLUE}Setting up Dev Maestro MCP for: $PROJECT_ROOT${NC}"

# Create .mcp.json
MCP_FILE="$PROJECT_ROOT/.mcp.json"

if [ -f "$MCP_FILE" ]; then
    # Check if dev-maestro already configured
    if grep -q "dev-maestro" "$MCP_FILE"; then
        echo -e "${YELLOW}dev-maestro already configured in .mcp.json${NC}"
    else
        echo -e "${YELLOW}Adding dev-maestro to existing .mcp.json${NC}"
        # Use jq if available, otherwise warn
        if command -v jq &> /dev/null; then
            jq '.mcpServers["dev-maestro"] = {"command": "node", "args": ["'"$INSTALL_DIR"'/mcp-server.js"], "env": {"DEV_MAESTRO_URL": "http://localhost:6010"}}' "$MCP_FILE" > "$MCP_FILE.tmp"
            mv "$MCP_FILE.tmp" "$MCP_FILE"
            echo -e "${GREEN}✓ Added dev-maestro to .mcp.json${NC}"
        else
            echo -e "${YELLOW}Warning: jq not found. Please manually add dev-maestro to .mcp.json${NC}"
        fi
    fi
else
    cat > "$MCP_FILE" << EOF
{
  "mcpServers": {
    "dev-maestro": {
      "command": "node",
      "args": ["$INSTALL_DIR/mcp-server.js"],
      "env": {
        "DEV_MAESTRO_URL": "http://localhost:6010"
      }
    }
  }
}
EOF
    echo -e "${GREEN}✓ Created .mcp.json${NC}"
fi

# Update .gitignore if needed
GITIGNORE="$PROJECT_ROOT/.gitignore"
if [ -f "$GITIGNORE" ]; then
    if ! grep -q "^\.mcp\.json$" "$GITIGNORE"; then
        echo ".mcp.json" >> "$GITIGNORE"
        echo -e "${GREEN}✓ Added .mcp.json to .gitignore${NC}"
    fi
fi

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Start Dev Maestro: cd ~/.dev-maestro && npm start"
echo "2. Start a new Claude Code session in your project"
echo "3. Claude Code will prompt to approve the dev-maestro MCP server"
echo ""
echo "Available tools after approval:"
echo "  - maestro_get_tasks    Get all tasks from MASTER_PLAN.md"
echo "  - maestro_update_status  Update task status"
echo "  - maestro_health       Get project health report"
echo "  - maestro_next_id      Get next available task ID"
