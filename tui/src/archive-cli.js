#!/usr/bin/env node
import { getMasterPlanPath } from './lib/masterplan-parser.js';
import { archiveDoneTasks } from './lib/archive-done-tasks.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysArg = args.find(a => a.startsWith('--days='));
const daysThreshold = daysArg ? parseInt(daysArg.split('=')[1], 10) : 14;

const masterPlanPath = getMasterPlanPath();
if (!masterPlanPath) {
  console.error('❌ Could not find MASTER_PLAN.md. Run from a project directory or set MAESTRO_CWD.');
  process.exit(1);
}

archiveDoneTasks(masterPlanPath, { dryRun, daysThreshold });
