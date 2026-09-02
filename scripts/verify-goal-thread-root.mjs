#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';

import {
  buildGoalThreadRelationIndex,
  toGoalPlanSnapshot,
} from '../apps/desktop/electron/main/task-overview-aggregator.mjs';

const ROOT_ID = '8aae68ea-4983-45f5-aadc-51769d210503';
const CHILD_ID = 'a4c84d91-1cbd-4255-8dd1-e26b49237567';
const storeDir = path.join(homedir(), '.peer-agent', 'goal-plans');

function loadPlan(planId) {
  return JSON.parse(readFileSync(path.join(storeDir, `${planId}.json`), 'utf8'));
}

const root = loadPlan(ROOT_ID);
const child = loadPlan(CHILD_ID);
const relationIndex = buildGoalThreadRelationIndex([root, child]);
const rootSnap = toGoalPlanSnapshot(root, { relationIndex });
const childSnap = toGoalPlanSnapshot(child, { relationIndex });

const failures = [];
if (relationIndex.rootPlanIdOf(ROOT_ID) !== ROOT_ID) {
  failures.push(`rootPlanIdOf(root)=${relationIndex.rootPlanIdOf(ROOT_ID)}`);
}
if (relationIndex.rootPlanIdOf(CHILD_ID) !== ROOT_ID) {
  failures.push(`rootPlanIdOf(child)=${relationIndex.rootPlanIdOf(CHILD_ID)}`);
}
if (rootSnap?.rootPlanId !== ROOT_ID || childSnap?.rootPlanId !== ROOT_ID) {
  failures.push(`snapshots root=${rootSnap?.rootPlanId} child=${childSnap?.rootPlanId}`);
}
if (rootSnap?.round !== 1 || childSnap?.round !== 2) {
  failures.push(`rounds root=${rootSnap?.round} child=${childSnap?.round}`);
}
if (childSnap?.parentPlanId !== ROOT_ID) {
  failures.push(`child parentPlanId=${childSnap?.parentPlanId}`);
}

if (failures.length) {
  console.error('Goal thread root check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  rootPlanId: ROOT_ID,
  titles: [root.title, child.title],
  rounds: [rootSnap.round, childSnap.round],
}, null, 2));
