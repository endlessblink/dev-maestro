#!/bin/bash
# =============================================================================
# E2E Tests for Watchpost Merge/Discard Workflow
# =============================================================================
# Tests the git worktree operations that power the agent isolation system.
# Uses a real temporary git repo — no mocks, no server dependency.
#
# Usage: bash tests/e2e/test-merge-discard.sh
# =============================================================================

set -uo pipefail

PASS=0
FAIL=0
TEST_DIR=""
CURRENT_TEST=""

# --- Helpers -----------------------------------------------------------------

pass() {
    ((PASS++))
    echo "  ✓ $1"
}

fail() {
    ((FAIL++))
    echo "  ✗ $1"
}

assert_eq() {
    if [[ "$1" == "$2" ]]; then
        pass "$3"
    else
        fail "$3 (expected '$2', got '$1')"
    fi
}

assert_contains() {
    if echo "$1" | grep -qF "$2"; then
        pass "$3"
    else
        fail "$3 (expected to contain '$2', got '$1')"
    fi
}

assert_exists() {
    if [[ -e "$1" ]]; then
        pass "$2"
    else
        fail "$2 ($1 not found)"
    fi
}

assert_not_exists() {
    if [[ ! -e "$1" ]]; then
        pass "$2"
    else
        fail "$2 ($1 still exists)"
    fi
}

assert_branch_exists() {
    if git -C "$TEST_DIR" branch --list "$1" | grep -q "$1"; then
        pass "$2"
    else
        fail "$2 (branch '$1' not found)"
    fi
}

assert_branch_not_exists() {
    if ! git -C "$TEST_DIR" branch --list "$1" | grep -q "$1"; then
        pass "$2"
    else
        fail "$2 (branch '$1' still exists)"
    fi
}

# --- Setup / Teardown --------------------------------------------------------

setup_repo() {
    TEST_DIR=$(mktemp -d)
    cd "$TEST_DIR" || exit 1
    git init --initial-branch=master . >/dev/null 2>&1
    git config user.email "test@test.com"
    git config user.name "Test User"
    echo "initial content" > file.txt
    git add file.txt
    git commit -m "Initial commit" >/dev/null 2>&1
    mkdir -p .agent-worktrees
}

cleanup_repo() {
    if [[ -n "$TEST_DIR" && -d "$TEST_DIR" ]]; then
        # Prune worktrees first so git doesn't complain
        git -C "$TEST_DIR" worktree prune 2>/dev/null || true
        rm -rf "$TEST_DIR"
    fi
}

# Mirrors server.js createAgentWorktree()
create_worktree() {
    local taskId="$1"
    local worktreePath="$TEST_DIR/.agent-worktrees/$taskId"
    local branchName="bd-$taskId"

    mkdir -p "$TEST_DIR/.agent-worktrees"

    if [[ -d "$worktreePath" ]]; then
        echo "exists"
        return 0
    fi

    # Create branch if not exists
    git -C "$TEST_DIR" branch "$branchName" 2>/dev/null || true

    # Create worktree
    git -C "$TEST_DIR" worktree add "$worktreePath" "$branchName" >/dev/null 2>&1
    echo "created"
}

# Mirrors server.js cleanupWorktree()
cleanup_worktree() {
    local taskId="$1"
    local worktreePath="$TEST_DIR/.agent-worktrees/$taskId"

    if [[ -d "$worktreePath" ]]; then
        git -C "$TEST_DIR" worktree remove "$worktreePath" --force 2>/dev/null
    fi
}

# Mirrors server.js merge endpoint logic
merge_branch() {
    local taskId="$1"
    local branchName="bd-$taskId"

    # Ensure we're on master
    local currentBranch
    currentBranch=$(git -C "$TEST_DIR" branch --show-current)
    if [[ "$currentBranch" != "master" && "$currentBranch" != "main" ]]; then
        git -C "$TEST_DIR" checkout master 2>/dev/null || git -C "$TEST_DIR" checkout main 2>/dev/null
    fi

    # Merge with --no-ff
    git -C "$TEST_DIR" merge "$branchName" --no-ff -m "Merge $branchName: Task completed" 2>&1

    # Cleanup worktree
    cleanup_worktree "$taskId"

    # Delete branch
    git -C "$TEST_DIR" branch -d "$branchName" 2>/dev/null || true
}

# Mirrors server.js cleanupStaleWorktrees() age check logic
cleanup_stale_worktrees() {
    local maxAgeSeconds="${1:-86400}"  # default 24h in seconds
    local worktreesDir="$TEST_DIR/.agent-worktrees"
    local cleaned=0

    if [[ ! -d "$worktreesDir" ]]; then
        echo "0"
        return
    fi

    local now
    now=$(date +%s)

    for entry in "$worktreesDir"/*/; do
        [[ -d "$entry" ]] || continue
        local name
        name=$(basename "$entry")
        local mtime
        mtime=$(stat -c %Y "$entry" 2>/dev/null || stat -f %m "$entry" 2>/dev/null)
        local age=$(( now - mtime ))

        if (( age > maxAgeSeconds )); then
            git -C "$TEST_DIR" worktree remove "$entry" --force 2>/dev/null || rm -rf "$entry"
            ((cleaned++))
        fi
    done

    git -C "$TEST_DIR" worktree prune 2>/dev/null || true

    # Clean orphaned bd-* branches (no corresponding worktree)
    local branches
    branches=$(git -C "$TEST_DIR" branch --list 'bd-*' 2>/dev/null | sed 's/^[* ]*//')
    for branch in $branches; do
        local tid="${branch#bd-}"
        local wt="$worktreesDir/$tid"
        if [[ ! -d "$wt" ]]; then
            git -C "$TEST_DIR" branch -D "$branch" >/dev/null 2>&1 || true
        fi
    done

    echo "$cleaned"
}

# --- Test Cases --------------------------------------------------------------

run_test() {
    CURRENT_TEST="$1"
    echo ""
    echo "--- $1 ---"
}

test_create_worktree() {
    run_test "Create worktree"
    setup_repo

    local result
    result=$(create_worktree "TASK-100")

    assert_eq "$result" "created" "worktree was created"
    assert_exists "$TEST_DIR/.agent-worktrees/TASK-100" "worktree directory exists"
    assert_branch_exists "bd-TASK-100" "branch bd-TASK-100 exists"

    # Verify the worktree is on the correct branch
    local wt_branch
    wt_branch=$(git -C "$TEST_DIR/.agent-worktrees/TASK-100" branch --show-current)
    assert_eq "$wt_branch" "bd-TASK-100" "worktree is on correct branch"

    cleanup_repo
}

test_create_worktree_idempotent() {
    run_test "Create worktree idempotent"
    setup_repo

    create_worktree "TASK-101" >/dev/null
    local result
    result=$(create_worktree "TASK-101")

    assert_eq "$result" "exists" "second create returns 'exists'"
    assert_exists "$TEST_DIR/.agent-worktrees/TASK-101" "worktree still exists"

    cleanup_repo
}

test_merge_workflow() {
    run_test "Merge workflow"
    setup_repo

    # Create worktree and make a change on the branch
    create_worktree "TASK-200" >/dev/null
    echo "feature work" > "$TEST_DIR/.agent-worktrees/TASK-200/feature.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-200" add feature.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-200" commit -m "Add feature" >/dev/null 2>&1

    # Merge
    local merge_output
    merge_output=$(merge_branch "TASK-200" 2>&1)

    # Verify the change is on master
    assert_exists "$TEST_DIR/feature.txt" "feature.txt merged to master"
    local content
    content=$(cat "$TEST_DIR/feature.txt")
    assert_eq "$content" "feature work" "file content is correct after merge"

    # Verify merge commit exists
    local log
    log=$(git -C "$TEST_DIR" log --oneline -1)
    assert_contains "$log" "Merge bd-TASK-200" "merge commit message is correct"

    cleanup_repo
}

test_merge_cleans_up_worktree() {
    run_test "Merge cleans up worktree directory"
    setup_repo

    create_worktree "TASK-201" >/dev/null
    echo "work" > "$TEST_DIR/.agent-worktrees/TASK-201/work.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-201" add work.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-201" commit -m "Work" >/dev/null 2>&1

    merge_branch "TASK-201" >/dev/null 2>&1

    assert_not_exists "$TEST_DIR/.agent-worktrees/TASK-201" "worktree directory removed after merge"

    cleanup_repo
}

test_merge_deletes_branch() {
    run_test "Merge deletes branch"
    setup_repo

    create_worktree "TASK-202" >/dev/null
    echo "x" > "$TEST_DIR/.agent-worktrees/TASK-202/x.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-202" add x.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-202" commit -m "X" >/dev/null 2>&1

    merge_branch "TASK-202" >/dev/null 2>&1

    assert_branch_not_exists "bd-TASK-202" "branch deleted after merge"

    cleanup_repo
}

test_discard_workflow() {
    run_test "Discard workflow (cleanup without merge)"
    setup_repo

    # Create worktree and make a change
    create_worktree "TASK-300" >/dev/null
    echo "discarded work" > "$TEST_DIR/.agent-worktrees/TASK-300/discard.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-300" add discard.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-300" commit -m "Discarded feature" >/dev/null 2>&1

    # Record master state before discard
    local master_hash_before
    master_hash_before=$(git -C "$TEST_DIR" rev-parse master)

    # Discard: just cleanup the worktree (do NOT merge)
    cleanup_worktree "TASK-300"

    # Verify master is unchanged
    local master_hash_after
    master_hash_after=$(git -C "$TEST_DIR" rev-parse master)
    assert_eq "$master_hash_after" "$master_hash_before" "master unchanged after discard"

    # Verify discarded file is NOT on master
    assert_not_exists "$TEST_DIR/discard.txt" "discarded file not on master"

    cleanup_repo
}

test_discard_removes_worktree() {
    run_test "Discard removes worktree directory"
    setup_repo

    create_worktree "TASK-301" >/dev/null
    cleanup_worktree "TASK-301"

    assert_not_exists "$TEST_DIR/.agent-worktrees/TASK-301" "worktree directory removed after discard"

    cleanup_repo
}

test_discard_branch_cleanup() {
    run_test "Discard allows branch force-deletion"
    setup_repo

    create_worktree "TASK-302" >/dev/null
    echo "work" > "$TEST_DIR/.agent-worktrees/TASK-302/w.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-302" add w.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-302" commit -m "Work" >/dev/null 2>&1

    cleanup_worktree "TASK-302"

    # Prune so git knows the worktree is gone
    git -C "$TEST_DIR" worktree prune

    # Force-delete unmerged branch
    git -C "$TEST_DIR" branch -D "bd-TASK-302" 2>/dev/null
    assert_branch_not_exists "bd-TASK-302" "branch force-deleted after discard"

    cleanup_repo
}

test_cleanup_stale_worktrees() {
    run_test "Cleanup stale worktrees"
    setup_repo

    # Create two worktrees
    create_worktree "TASK-400" >/dev/null
    create_worktree "TASK-401" >/dev/null

    # Make TASK-400 "old" by backdating its mtime
    touch -d "2 days ago" "$TEST_DIR/.agent-worktrees/TASK-400"

    # Run cleanup with 1-hour threshold (3600 seconds)
    local cleaned
    cleaned=$(cleanup_stale_worktrees 3600)

    assert_eq "$cleaned" "1" "exactly 1 stale worktree cleaned"
    assert_not_exists "$TEST_DIR/.agent-worktrees/TASK-400" "stale worktree removed"
    assert_exists "$TEST_DIR/.agent-worktrees/TASK-401" "fresh worktree kept"

    cleanup_repo
}

test_cleanup_orphaned_branches() {
    run_test "Cleanup orphaned branches"
    setup_repo

    # Create a worktree then remove it manually (leaving orphan branch)
    create_worktree "TASK-410" >/dev/null
    rm -rf "$TEST_DIR/.agent-worktrees/TASK-410"
    git -C "$TEST_DIR" worktree prune

    assert_branch_exists "bd-TASK-410" "orphan branch exists before cleanup"

    # Run cleanup — should delete orphaned branch
    cleanup_stale_worktrees 0 >/dev/null

    assert_branch_not_exists "bd-TASK-410" "orphan branch deleted by cleanup"

    cleanup_repo
}

test_merge_conflict() {
    run_test "Merge with conflict fails gracefully"
    setup_repo

    # Create worktree and modify file.txt on branch
    create_worktree "TASK-500" >/dev/null
    echo "branch change" > "$TEST_DIR/.agent-worktrees/TASK-500/file.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-500" add file.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-500" commit -m "Branch change" >/dev/null 2>&1

    # Also modify file.txt on master (create conflict)
    echo "master change" > "$TEST_DIR/file.txt"
    git -C "$TEST_DIR" add file.txt
    git -C "$TEST_DIR" commit -m "Master change" >/dev/null 2>&1

    # Attempt merge — should fail
    local merge_output
    merge_output=$(merge_branch "TASK-500" 2>&1)
    local merge_exit=$?

    if [[ $merge_exit -ne 0 ]] || echo "$merge_output" | grep -qi "conflict"; then
        pass "merge with conflict returns error"
    else
        fail "merge with conflict should have failed"
    fi

    # Abort the merge if git is in merge state
    git -C "$TEST_DIR" merge --abort 2>/dev/null || true

    cleanup_repo
}

test_cleanup_nonexistent_worktree() {
    run_test "Cleanup nonexistent worktree doesn't crash"
    setup_repo

    # Should not error
    cleanup_worktree "TASK-DOESNOTEXIST"
    local exit_code=$?

    assert_eq "$exit_code" "0" "cleanup of nonexistent worktree succeeds silently"

    cleanup_repo
}

test_multiple_worktrees() {
    run_test "Multiple concurrent worktrees"
    setup_repo

    create_worktree "TASK-600" >/dev/null
    create_worktree "TASK-601" >/dev/null
    create_worktree "TASK-602" >/dev/null

    assert_exists "$TEST_DIR/.agent-worktrees/TASK-600" "worktree 600 exists"
    assert_exists "$TEST_DIR/.agent-worktrees/TASK-601" "worktree 601 exists"
    assert_exists "$TEST_DIR/.agent-worktrees/TASK-602" "worktree 602 exists"

    # Each should be on its own branch
    local b600 b601 b602
    b600=$(git -C "$TEST_DIR/.agent-worktrees/TASK-600" branch --show-current)
    b601=$(git -C "$TEST_DIR/.agent-worktrees/TASK-601" branch --show-current)
    b602=$(git -C "$TEST_DIR/.agent-worktrees/TASK-602" branch --show-current)

    assert_eq "$b600" "bd-TASK-600" "worktree 600 on correct branch"
    assert_eq "$b601" "bd-TASK-601" "worktree 601 on correct branch"
    assert_eq "$b602" "bd-TASK-602" "worktree 602 on correct branch"

    # Changes in one don't affect others
    echo "only600" > "$TEST_DIR/.agent-worktrees/TASK-600/only600.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-600" add only600.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-600" commit -m "600 only" >/dev/null 2>&1

    assert_not_exists "$TEST_DIR/.agent-worktrees/TASK-601/only600.txt" "601 isolated from 600"
    assert_not_exists "$TEST_DIR/only600.txt" "master isolated from 600"

    cleanup_repo
}

test_merge_preserves_other_worktrees() {
    run_test "Merge one branch preserves other worktrees"
    setup_repo

    create_worktree "TASK-700" >/dev/null
    create_worktree "TASK-701" >/dev/null

    echo "merge me" > "$TEST_DIR/.agent-worktrees/TASK-700/merged.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-700" add merged.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-700" commit -m "Merge me" >/dev/null 2>&1

    echo "keep me" > "$TEST_DIR/.agent-worktrees/TASK-701/kept.txt"
    git -C "$TEST_DIR/.agent-worktrees/TASK-701" add kept.txt
    git -C "$TEST_DIR/.agent-worktrees/TASK-701" commit -m "Keep me" >/dev/null 2>&1

    # Merge only TASK-700
    merge_branch "TASK-700" >/dev/null 2>&1

    assert_exists "$TEST_DIR/merged.txt" "TASK-700 changes merged to master"
    assert_not_exists "$TEST_DIR/.agent-worktrees/TASK-700" "TASK-700 worktree cleaned up"
    assert_exists "$TEST_DIR/.agent-worktrees/TASK-701" "TASK-701 worktree still exists"
    assert_branch_exists "bd-TASK-701" "TASK-701 branch still exists"

    cleanup_repo
}

# --- Runner ------------------------------------------------------------------

main() {
    echo "============================================="
    echo "  Watchpost Merge/Discard E2E Tests"
    echo "============================================="

    test_create_worktree
    test_create_worktree_idempotent
    test_merge_workflow
    test_merge_cleans_up_worktree
    test_merge_deletes_branch
    test_discard_workflow
    test_discard_removes_worktree
    test_discard_branch_cleanup
    test_cleanup_stale_worktrees
    test_cleanup_orphaned_branches
    test_merge_conflict
    test_cleanup_nonexistent_worktree
    test_multiple_worktrees
    test_merge_preserves_other_worktrees

    echo ""
    echo "============================================="
    echo "  Results: $PASS passed, $FAIL failed"
    echo "============================================="

    if [[ $FAIL -gt 0 ]]; then
        exit 1
    fi
    exit 0
}

main "$@"
