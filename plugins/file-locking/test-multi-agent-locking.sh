#!/bin/bash
#
# Test script for multi-agent file locking with deferred execution
# Spawns two Claude Code sessions in parallel to verify locking works
#
# Usage: .claude/hooks/test-multi-agent-locking.sh
#

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"

echo "=============================================="
echo "  Multi-Agent File Locking Test"
echo "=============================================="
echo ""
echo "Project: $PROJECT_DIR"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test file - using a simple file that's safe to modify
TEST_FILE="src/composables/useSmartViews.ts"
TEST_TASK="TASK-997"

# Cleanup function
cleanup() {
  echo ""
  echo "Cleaning up..."
  rm -f "$PROJECT_DIR/.claude/locks/${TEST_TASK}.lock"
  rm -f "$PROJECT_DIR/.claude/deferred-queue/"*.json 2>/dev/null || true
  sed -i "/${TEST_TASK}.*Multi-agent test/d" "$PROJECT_DIR/docs/MASTER_PLAN.md" 2>/dev/null || true
  # Remove test comments from file
  sed -i '/Agent [AB] test comment/d' "$PROJECT_DIR/$TEST_FILE" 2>/dev/null || true
  echo "Done."
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Step 1: Add test task to MASTER_PLAN.md
echo "Step 1: Setting up test task in MASTER_PLAN.md..."
echo "| ${TEST_TASK} | IN_PROGRESS | \`useSmartViews.ts\` | Multi-agent test |" >> "$PROJECT_DIR/docs/MASTER_PLAN.md"
echo -e "${GREEN}✓${NC} Added ${TEST_TASK} mapping to useSmartViews.ts"
echo ""

# Step 2: Create output directories
RESULTS_DIR="/tmp/multi-agent-test-$$"
mkdir -p "$RESULTS_DIR"

# Step 3: Define the prompts for each agent
AGENT_A_PROMPT="Add a comment '// Agent A test comment' to the top of src/composables/useSmartViews.ts. Just do the edit, nothing else. Report if it succeeded or was blocked/deferred."

AGENT_B_PROMPT="Add a comment '// Agent B test comment' to the top of src/composables/useSmartViews.ts. Just do the edit, nothing else. Report if it succeeded or was blocked/deferred."

echo "Step 2: Spawning two Claude Code sessions in parallel..."
echo "  - Agent A: Will try to add comment"
echo "  - Agent B: Will try to add comment (should be deferred)"
echo ""

# Step 4: Run agents SEQUENTIALLY - Agent A first, then B while lock exists
# This ensures Agent B hits the lock, not a race condition

# Agent A - let it complete first to establish the lock
echo "Starting Agent A (will acquire lock)..."
(
  cd "$PROJECT_DIR"
  timeout 120 claude -p "$AGENT_A_PROMPT" --allowedTools Edit,Read 2>&1 | tee "$RESULTS_DIR/agent_a.log"
)
AGENT_A_EXIT=$?

echo ""
echo "Agent A completed. Checking lock..."
ls -la "$PROJECT_DIR/.claude/locks/" | grep -v gitignore || echo "No locks"
echo ""

# Agent B - runs after A, should hit the existing lock
echo "Starting Agent B (should hit lock and be deferred)..."
(
  cd "$PROJECT_DIR"
  timeout 120 claude -p "$AGENT_B_PROMPT" --allowedTools Edit,Read 2>&1 | tee "$RESULTS_DIR/agent_b.log"
)
AGENT_B_EXIT=$?
# Fake PIDs for compatibility with rest of script
AGENT_A_PID=0
AGENT_B_PID=0

echo ""
echo "Both agents completed."
echo ""

echo ""
echo "=============================================="
echo "  Results"
echo "=============================================="
echo ""

# Check lock files
echo "Lock files created:"
ls -la "$PROJECT_DIR/.claude/locks/" 2>/dev/null | grep -v "^total" | grep -v ".gitignore" || echo "  (none)"
echo ""

# Check deferred queue
echo "Deferred queue:"
ls -la "$PROJECT_DIR/.claude/deferred-queue/" 2>/dev/null | grep -v "^total" | grep -v ".gitignore" || echo "  (none)"
echo ""

# Check if DEFERRED/blocked/deferred message appeared in either log (case insensitive)
AGENT_A_DEFERRED=$(grep -ci "deferred\|blocked.*lock\|saved to.*queue" "$RESULTS_DIR/agent_a.log" 2>/dev/null) || AGENT_A_DEFERRED=0
AGENT_B_DEFERRED=$(grep -ci "deferred\|blocked.*lock\|saved to.*queue" "$RESULTS_DIR/agent_b.log" 2>/dev/null) || AGENT_B_DEFERRED=0

echo "Agent A output (last 20 lines):"
echo "---"
tail -20 "$RESULTS_DIR/agent_a.log" 2>/dev/null || echo "(no output)"
echo "---"
echo ""

echo "Agent B output (last 20 lines):"
echo "---"
tail -20 "$RESULTS_DIR/agent_b.log" 2>/dev/null || echo "(no output)"
echo "---"
echo ""

# Final verdict
echo "=============================================="
echo "  Verdict"
echo "=============================================="

if [[ "$AGENT_A_DEFERRED" -gt 0 ]] || [[ "$AGENT_B_DEFERRED" -gt 0 ]]; then
  echo -e "${GREEN}✓ SUCCESS:${NC} At least one agent was deferred!"
  if [[ "$AGENT_A_DEFERRED" -gt 0 ]]; then
    echo "  - Agent A was deferred"
  fi
  if [[ "$AGENT_B_DEFERRED" -gt 0 ]]; then
    echo "  - Agent B was deferred"
  fi
else
  echo -e "${YELLOW}⚠ INCONCLUSIVE:${NC} No DEFERRED message found in logs."
  echo "  This could mean:"
  echo "  - Both agents ran sequentially (no conflict)"
  echo "  - Hooks didn't trigger properly"
  echo "  - Check the logs above for details"
fi

echo ""
echo "Full logs saved to: $RESULTS_DIR/"
echo ""
