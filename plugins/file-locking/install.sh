#!/bin/bash
#
# Dev-Maestro File Locking Plugin Installer
# Installs multi-agent file locking with deferred execution
#
# Usage: ~/.dev-maestro/plugins/file-locking/install.sh [PROJECT_DIR]
#

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${1:-$(pwd)}"

echo "=== Dev-Maestro File Locking Plugin ==="
echo "Installing to: $PROJECT_DIR"
echo ""

# Verify project has .claude directory
if [[ ! -d "$PROJECT_DIR/.claude" ]]; then
  echo "Creating .claude directory..."
  mkdir -p "$PROJECT_DIR/.claude"
fi

# Create hooks directory
mkdir -p "$PROJECT_DIR/.claude/hooks"

# Copy hooks
echo "Installing hooks..."
cp "$PLUGIN_DIR/task-lock-enforcer.sh" "$PROJECT_DIR/.claude/hooks/"
cp "$PLUGIN_DIR/deferred-reminder.sh" "$PROJECT_DIR/.claude/hooks/"
chmod +x "$PROJECT_DIR/.claude/hooks/task-lock-enforcer.sh"
chmod +x "$PROJECT_DIR/.claude/hooks/deferred-reminder.sh"
echo "  - task-lock-enforcer.sh (PreToolUse)"
echo "  - deferred-reminder.sh (UserPromptSubmit)"

# Create locks directory
echo "Creating locks directory..."
mkdir -p "$PROJECT_DIR/.claude/locks"
echo "*.lock" > "$PROJECT_DIR/.claude/locks/.gitignore"

# Create deferred-queue directory
echo "Creating deferred-queue directory..."
mkdir -p "$PROJECT_DIR/.claude/deferred-queue"
echo "*.json" > "$PROJECT_DIR/.claude/deferred-queue/.gitignore"

# Check/update settings.json
SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"
if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "Creating settings.json..."
  cat > "$SETTINGS_FILE" << 'EOF'
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/task-lock-enforcer.sh"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/deferred-reminder.sh"
          }
        ]
      }
    ]
  }
}
EOF
else
  echo ""
  echo "settings.json already exists."
  echo "Please manually add the hooks if not present:"
  echo ""
  echo '  "PreToolUse": [{ "hooks": [{ "type": "command", "command": ".claude/hooks/task-lock-enforcer.sh" }] }]'
  echo '  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": ".claude/hooks/deferred-reminder.sh" }] }]'
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo "1. Ensure your MASTER_PLAN.md (or docs/MASTER_PLAN.md) has task-to-file mappings:"
echo "   | TASK-123 | IN_PROGRESS | \`file.vue, other.ts\` | Description |"
echo ""
echo "2. Install inotify-tools for efficient file watching (optional but recommended):"
echo "   sudo apt install inotify-tools  # Ubuntu/Debian"
echo ""
echo "3. Start multiple Claude Code sessions and test!"
echo ""
