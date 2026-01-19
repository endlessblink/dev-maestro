#!/bin/bash
# Dev Maestro Project Setup - AI Agent Friendly
#
# This script is designed for automated/programmatic use by AI agents.
# It's fully non-interactive and provides clear exit codes.
#
# Usage:
#   ./scripts/setup-project.sh /path/to/project
#   ./scripts/setup-project.sh /path/to/MASTER_PLAN.md
#   ./scripts/setup-project.sh --current  # Use current .env config
#
# Exit Codes:
#   0 - Success
#   1 - Invalid arguments
#   2 - Project/file not found
#   3 - Configuration error
#
# Output: JSON on success, error message on failure

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

# Find MASTER_PLAN.md in a project directory
find_master_plan() {
    local project_root="$1"

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

    # Fallback: search for it
    local found=$(find "$project_root" -maxdepth 3 -name "MASTER_PLAN.md" -type f 2>/dev/null | head -1)
    if [ -n "$found" ]; then
        echo "$found"
        return 0
    fi

    return 1
}

# Get project root from MASTER_PLAN.md path
get_project_root() {
    local plan_path="$1"
    local plan_dir=$(dirname "$plan_path")
    local plan_dirname=$(basename "$plan_dir")

    if [[ "$plan_dirname" =~ ^(docs|doc|planning|\.github)$ ]]; then
        dirname "$plan_dir"
    else
        echo "$plan_dir"
    fi
}

# Resolve to absolute path
resolve_path() {
    local input="$1"
    input="${input/#\~/$HOME}"
    if command -v realpath >/dev/null 2>&1; then
        realpath "$input" 2>/dev/null || echo "$input"
    else
        (cd "$(dirname "$input")" 2>/dev/null && echo "$(pwd)/$(basename "$input")") || echo "$input"
    fi
}

# Output JSON result
output_json() {
    local status="$1"
    local message="$2"
    local project_root="$3"
    local master_plan="$4"

    cat << EOF
{
  "status": "$status",
  "message": "$message",
  "projectRoot": "$project_root",
  "masterPlanPath": "$master_plan",
  "installDir": "$INSTALL_DIR",
  "serverUrl": "http://localhost:6010",
  "apiStatus": "http://localhost:6010/api/status"
}
EOF
}

# ============================================================================
# MAIN
# ============================================================================

# Check arguments
if [ $# -eq 0 ]; then
    echo "Error: Missing project path argument" >&2
    echo "Usage: $0 /path/to/project" >&2
    echo "       $0 /path/to/MASTER_PLAN.md" >&2
    echo "       $0 --current" >&2
    exit 1
fi

INPUT="$1"
MASTER_PLAN_PATH=""
PROJECT_ROOT=""

# Handle --current flag
if [ "$INPUT" = "--current" ]; then
    if [ -f "$INSTALL_DIR/.env" ]; then
        MASTER_PLAN_PATH=$(grep -E "^MASTER_PLAN_PATH=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
        if [ -n "$MASTER_PLAN_PATH" ] && [ -f "$MASTER_PLAN_PATH" ]; then
            PROJECT_ROOT=$(get_project_root "$MASTER_PLAN_PATH")
            output_json "ok" "Using current configuration" "$PROJECT_ROOT" "$MASTER_PLAN_PATH"
            exit 0
        fi
    fi
    echo "Error: No valid current configuration found" >&2
    exit 3
fi

# Resolve the input path
INPUT=$(resolve_path "$INPUT")

# Determine if input is a file or directory
if [ -f "$INPUT" ]; then
    # Direct path to MASTER_PLAN.md
    if [[ "$(basename "$INPUT")" != "MASTER_PLAN.md" ]]; then
        echo "Error: File must be named MASTER_PLAN.md, got: $(basename "$INPUT")" >&2
        exit 2
    fi
    MASTER_PLAN_PATH="$INPUT"
    PROJECT_ROOT=$(get_project_root "$MASTER_PLAN_PATH")
elif [ -d "$INPUT" ]; then
    # Directory - search for MASTER_PLAN.md
    PROJECT_ROOT="$INPUT"
    MASTER_PLAN_PATH=$(find_master_plan "$PROJECT_ROOT")
    if [ -z "$MASTER_PLAN_PATH" ]; then
        echo "Error: Could not find MASTER_PLAN.md in $PROJECT_ROOT" >&2
        echo "Searched: MASTER_PLAN.md, docs/MASTER_PLAN.md, planning/MASTER_PLAN.md" >&2
        exit 2
    fi
else
    echo "Error: Path not found: $INPUT" >&2
    exit 2
fi

# Validate the file exists
if [ ! -f "$MASTER_PLAN_PATH" ]; then
    echo "Error: MASTER_PLAN.md not found at $MASTER_PLAN_PATH" >&2
    exit 2
fi

# Update .env configuration
ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "MASTER_PLAN_PATH=$MASTER_PLAN_PATH" > "$ENV_FILE"
elif grep -q "^MASTER_PLAN_PATH=" "$ENV_FILE"; then
    sed -i "s|^MASTER_PLAN_PATH=.*|MASTER_PLAN_PATH=$MASTER_PLAN_PATH|" "$ENV_FILE"
else
    echo "MASTER_PLAN_PATH=$MASTER_PLAN_PATH" >> "$ENV_FILE"
fi

# Create .dev-maestro.json marker in project
cat > "$PROJECT_ROOT/.dev-maestro.json" << EOF
{
  "installed": true,
  "installDir": "$INSTALL_DIR",
  "port": 6010,
  "masterPlanPath": "$MASTER_PLAN_PATH",
  "url": "http://localhost:6010",
  "apiStatus": "http://localhost:6010/api/status",
  "setupCommand": "$INSTALL_DIR/scripts/setup-project.sh $PROJECT_ROOT"
}
EOF

# Create maestro.sh launcher
cat > "$PROJECT_ROOT/maestro.sh" << LAUNCHER
#!/bin/bash
# Dev Maestro Launcher - Generated for $(basename "$PROJECT_ROOT")
INSTALL_DIR="\${DEV_MAESTRO_DIR:-\$HOME/.dev-maestro}"
export MASTER_PLAN_PATH="$MASTER_PLAN_PATH"
cd "\$INSTALL_DIR" && npm start
LAUNCHER
chmod +x "$PROJECT_ROOT/maestro.sh"

# Output success JSON
output_json "ok" "Project configured successfully" "$PROJECT_ROOT" "$MASTER_PLAN_PATH"
exit 0
