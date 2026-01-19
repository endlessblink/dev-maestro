#!/bin/bash
# Dev Maestro Bootstrap - One-command setup for AI agents
#
# This script:
# 1. Installs Dev Maestro if not present (clones repo)
# 2. Configures it for the specified project
# 3. Optionally starts the server
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/scripts/bootstrap.sh | bash -s -- /path/to/project
#   ./bootstrap.sh /path/to/project
#   ./bootstrap.sh /path/to/project --start
#
# For AI agents - copy this one-liner:
#   curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/scripts/bootstrap.sh | bash -s -- "$(pwd)"

set -e

REPO_URL="https://github.com/endlessblink/dev-maestro.git"
INSTALL_DIR="${DEV_MAESTRO_DIR:-$HOME/.dev-maestro}"
PROJECT_PATH="${1:-$(pwd)}"
START_SERVER=false

# Check for --start flag
if [[ "$*" == *"--start"* ]]; then
    START_SERVER=true
fi

# Expand ~ to $HOME
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
PROJECT_PATH="${PROJECT_PATH/#\~/$HOME}"

echo "=== Dev Maestro Bootstrap ==="

# Step 1: Install if needed
if [ ! -d "$INSTALL_DIR/.git" ]; then
    echo "[1/3] Installing Dev Maestro..."

    # Check prerequisites
    command -v git >/dev/null 2>&1 || { echo "Error: git required"; exit 1; }
    command -v node >/dev/null 2>&1 || { echo "Error: node required"; exit 1; }
    command -v npm >/dev/null 2>&1 || { echo "Error: npm required"; exit 1; }

    # Clone repository
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null

    # Install dependencies
    cd "$INSTALL_DIR" && npm install --silent 2>/dev/null

    # Create local/ structure
    mkdir -p "$INSTALL_DIR/local/icons" "$INSTALL_DIR/local/css" "$INSTALL_DIR/local/views"
    echo '{"port":6010,"autoUpdate":true}' > "$INSTALL_DIR/local/config.json"

    echo "[1/3] ✓ Installed to $INSTALL_DIR"
else
    echo "[1/3] ✓ Already installed at $INSTALL_DIR"
fi

# Step 2: Configure for project
echo "[2/3] Configuring for project: $PROJECT_PATH"

# Find MASTER_PLAN.md
find_master_plan() {
    local dir="$1"
    for loc in "$dir/MASTER_PLAN.md" "$dir/docs/MASTER_PLAN.md" "$dir/planning/MASTER_PLAN.md"; do
        [ -f "$loc" ] && echo "$loc" && return 0
    done
    find "$dir" -maxdepth 3 -name "MASTER_PLAN.md" -type f 2>/dev/null | head -1
}

if [ -f "$PROJECT_PATH" ]; then
    # Direct path to MASTER_PLAN.md
    MASTER_PLAN="$PROJECT_PATH"
    PROJECT_ROOT=$(dirname "$MASTER_PLAN")
    # Go up if in docs/
    [[ "$(basename "$PROJECT_ROOT")" =~ ^(docs|planning)$ ]] && PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
elif [ -d "$PROJECT_PATH" ]; then
    PROJECT_ROOT="$PROJECT_PATH"
    MASTER_PLAN=$(find_master_plan "$PROJECT_ROOT")
else
    echo "Error: Path not found: $PROJECT_PATH"
    exit 1
fi

if [ -z "$MASTER_PLAN" ] || [ ! -f "$MASTER_PLAN" ]; then
    echo "Error: Could not find MASTER_PLAN.md in $PROJECT_ROOT"
    echo "Searched: MASTER_PLAN.md, docs/MASTER_PLAN.md, planning/MASTER_PLAN.md"
    exit 1
fi

# Resolve to absolute paths
PROJECT_ROOT=$(cd "$PROJECT_ROOT" && pwd)
MASTER_PLAN=$(cd "$(dirname "$MASTER_PLAN")" && echo "$(pwd)/$(basename "$MASTER_PLAN")")

# Update .env
ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    sed -i "s|^MASTER_PLAN_PATH=.*|MASTER_PLAN_PATH=$MASTER_PLAN|" "$ENV_FILE" 2>/dev/null || \
    echo "MASTER_PLAN_PATH=$MASTER_PLAN" >> "$ENV_FILE"
else
    echo "MASTER_PLAN_PATH=$MASTER_PLAN" > "$ENV_FILE"
fi

# Create project marker with AI agent instructions
cat > "$PROJECT_ROOT/.dev-maestro.json" << EOF
{
  "name": "Dev Maestro",
  "description": "AI agent task tracking via MASTER_PLAN.md",
  "installed": true,
  "installDir": "$INSTALL_DIR",
  "masterPlanPath": "$MASTER_PLAN",
  "url": "http://localhost:6010",
  "ai_agent_instructions": {
    "bootstrap": "curl -sSL https://raw.githubusercontent.com/endlessblink/dev-maestro/main/scripts/bootstrap.sh | bash -s -- \"$PROJECT_ROOT\"",
    "start": "$PROJECT_ROOT/maestro.sh",
    "check_running": "curl -s http://localhost:6010/api/status",
    "get_tasks": "curl -s http://localhost:6010/api/tasks",
    "docs": "$INSTALL_DIR/AI-AGENT-GUIDE.md"
  }
}
EOF

# Create launcher
cat > "$PROJECT_ROOT/maestro.sh" << LAUNCHER
#!/bin/bash
export MASTER_PLAN_PATH="$MASTER_PLAN"
cd "\${DEV_MAESTRO_DIR:-\$HOME/.dev-maestro}" && npm start
LAUNCHER
chmod +x "$PROJECT_ROOT/maestro.sh"

echo "[2/3] ✓ Configured: $MASTER_PLAN"

# Step 3: Start server (optional)
if [ "$START_SERVER" = true ]; then
    echo "[3/3] Starting server..."
    cd "$INSTALL_DIR"
    export MASTER_PLAN_PATH="$MASTER_PLAN"
    npm start &
    sleep 2
    echo "[3/3] ✓ Server running at http://localhost:6010"
else
    echo "[3/3] To start: cd $INSTALL_DIR && npm start"
    echo "    Or run: $PROJECT_ROOT/maestro.sh"
fi

# Output JSON for AI agents
echo ""
echo "=== Configuration Complete ==="
cat << EOF
{
  "status": "ok",
  "projectRoot": "$PROJECT_ROOT",
  "masterPlanPath": "$MASTER_PLAN",
  "installDir": "$INSTALL_DIR",
  "serverUrl": "http://localhost:6010",
  "startCommand": "$PROJECT_ROOT/maestro.sh"
}
EOF
