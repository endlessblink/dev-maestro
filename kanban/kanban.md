# Task Board

**Last Updated**: December 23, 2025
**Source**: Synced with MASTER_PLAN.md

## 📋 To Do

### TASK-001 | Enable Auto-Sync (Phase 5)
**Priority**: HIGH
**Tags**: #sync #couchdb
**Created**: 2025-12-05
Prerequisites: Test sync from both devices, verify tasks on both sides, run 5-10 successful manual syncs.
**Status**: Roadmap item ROAD-005

### TASK-005 | Safari ITP Protection
**Priority**: CRITICAL
**Tags**: #data-safety #safari
**Created**: 2025-12-04
Safari ITP deletes IndexedDB data after 7 days. Need warning toast and manual sync button.
**Status**: ISSUE-004 - Detection exists, no mitigation yet

### TASK-006 | QuotaExceededError Handling
**Priority**: CRITICAL
**Tags**: #data-safety #error
**Created**: 2025-12-04
App crashes when storage full. Need graceful error catch and quota display.
**Status**: ISSUE-005 - Functions exist, not enforced

### TASK-009 | Drag-and-Drop Unification
**Priority**: MEDIUM
**Tags**: #tech-debt #dnd
**Created**: 2025-12-01
Create unified useDraggable() for 18 D&D implementations. 150+ conflicts.
**Status**: Roadmap item ROAD-007

### TASK-010 | Database Layer Consolidation
**Priority**: MEDIUM
**Tags**: #tech-debt #database
**Created**: 2025-12-01
Consolidate 574 database conflicts into unified data access layer.
**Status**: Roadmap item ROAD-007

### TASK-011 | Validation System Standardization
**Priority**: LOW
**Tags**: #tech-debt #validation
**Created**: 2025-12-01
Consolidate 4,199 validation conflicts into unified framework.
**Status**: Roadmap item ROAD-007

## 🚀 In Progress

*(No tasks currently in progress from this legacy board)*

## 👀 Review

### TASK-014 | Error Handling Migration
**Priority**: LOW
**Tags**: #tech-debt #errors
**Created**: 2025-12-01
Strategic minimum complete. 116 files deferred for organic migration.

## ✅ Done

### TASK-002 | Calendar Ghost Preview Fix
**Priority**: MEDIUM
**Tags**: #calendar #bug
**Created**: 2025-12-04
**Completed**: 2025-12-02
Ghost preview appears in wrong location during drag operations.
**Resolution**: BUG-009 FIXED - SOP verified

### TASK-003 | Calendar Resize Artifacts Fix
**Priority**: HIGH
**Tags**: #calendar #bug
**Created**: 2025-12-04
**Completed**: 2025-12-19
Visual glitches appear during calendar event resize operations.
**Resolution**: BUG-010 VERIFIED WORKING

### TASK-004 | Calendar Resize Both Sides Fix
**Priority**: HIGH
**Tags**: #calendar #bug
**Created**: 2025-12-04
**Completed**: 2025-12-19
Resize only works on one side, should work on both.
**Resolution**: BUG-011 VERIFIED WORKING

### TASK-007 | PouchDB Conflict Detection
**Priority**: HIGH
**Tags**: #data-safety #sync
**Created**: 2025-12-04
**Completed**: 2025-12-20
Add conflicts:true to db.get(), log conflicts, show warning banner.
**Resolution**: ISSUE-011 RESOLVED - All 1,487 conflicts deleted

### TASK-008 | Calendar System Consolidation
**Priority**: MEDIUM
**Tags**: #tech-debt #calendar
**Created**: 2025-12-01
**Completed**: 2025-12-05
Unify 6 calendar files into single useCalendar() composable.
**Resolution**: TASK-005 in MASTER_PLAN archive - Phase 2 complete

### TASK-012 | IndexedDB Version Mismatch Fix
**Priority**: MEDIUM
**Tags**: #database #bug
**Created**: 2025-12-01
**Completed**: 2025-12-20
Database version mismatch error needs proper migration handling.
**Resolution**: Individual document storage eliminates version conflicts

### TASK-013 | Manual CouchDB Sync Testing
**Priority**: HIGH
**Tags**: #sync #testing
**Created**: 2025-12-05
**Completed**: 2025-12-22
Manual sync working on Linux. Need to test on second device.
**Resolution**: Live sync enabled and verified across devices

### TASK-100 | Canvas Auto-Update Fix
**Priority**: CRITICAL
**Tags**: #canvas #bug
**Created**: 2025-12-04
**Completed**: 2025-12-04
Fixed drag from inbox and task edit updates.

### TASK-101 | QA Issues Fix (5 Issues)
**Priority**: HIGH
**Tags**: #qa #bugs
**Created**: 2025-12-04
**Completed**: 2025-12-04
Fixed phantom clicks, performance loop, Quick Sort, naming, reload issue.

### TASK-102 | Feature Restoration
**Priority**: MEDIUM
**Tags**: #features
**Created**: 2025-12-04
**Completed**: 2025-12-04
Fixed QuickSort, Sidebar Colors, Context Menu, Unified Inbox.

### TASK-103 | Canvas Visibility Bugs (7)
**Priority**: CRITICAL
**Tags**: #canvas #bugs
**Created**: 2025-12-04
**Completed**: 2025-12-04
All 7 canvas bugs fixed. Added batch selection feature.

### TASK-104 | CouchDB Sync Phases 1-4
**Priority**: HIGH
**Tags**: #sync #couchdb
**Created**: 2025-12-04
**Completed**: 2025-12-04
Vue watcher fixes, hard-disable removal, UI integration, debugging.

### TASK-105 | Sync Data Reverts Fix
**Priority**: CRITICAL
**Tags**: #sync #bug
**Created**: 2025-12-05
**Completed**: 2025-12-05
Changed sync to PULL FIRST. Removed stale fallback files.

### TASK-106 | Remove My Tasks Filter
**Priority**: HIGH
**Tags**: #cleanup
**Created**: 2025-11-29
**Completed**: 2025-12-01
Removed synthetic My Tasks project. Tasks use projectId: null.

### TASK-107 | Sidebar Filters Fix
**Priority**: MEDIUM
**Tags**: #bug #sidebar
**Created**: 2025-12-01
**Completed**: 2025-12-01
All Active and Uncategorized now clear project filter.

### TASK-108 | Test Infrastructure Fix
**Priority**: HIGH
**Tags**: #testing #ci
**Created**: 2025-12-01
**Completed**: 2025-12-01
Fixed syntax errors. 18/18 core E2E tests pass.

### TASK-109 | Error Handling Infrastructure
**Priority**: HIGH
**Tags**: #tech-debt #errors
**Created**: 2025-12-01
**Completed**: 2025-12-01
Created errorHandler.ts. Migrated 6 core files, 45 locations.

### TASK-110 | Sync Safety Architecture
**Priority**: HIGH
**Tags**: #sync #safety
**Created**: 2025-12-04
**Completed**: 2025-12-04
Cross-tab batching, leader election, deep watcher removal, sync queue.
