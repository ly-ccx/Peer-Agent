import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = () => readFile(new URL('./GoalPlanPanel.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../styles/goal-panel.css', import.meta.url), 'utf8');

test('GoalPlanPanel treats missing evidenceRefs as an empty list', async () => {
  const source = await readSource();

  assert.match(source, /function safeEvidenceRefs\(/);
  assert.match(source, /Array\.isArray\(value\?\.evidenceRefs\) \? value\.evidenceRefs : \[\]/);
  assert.match(source, /const evidenceRefs = safeEvidenceRefs\(task\)/);
  assert.match(source, /const evidenceRefs = safeEvidenceRefs\(event\)/);
  assert.doesNotMatch(source, /task\.evidenceRefs\.length/);
  assert.doesNotMatch(source, /event\.evidenceRefs\.length/);
  assert.doesNotMatch(source, /task\.evidenceRefs\.map\(/);
});

test('GoalPlanPanel keeps PlanCard but does not render parent origin or derived child goals', async () => {
  const source = await readSource();
  const styles = await readStyles();

  assert.match(source, /const PlanCard = memo\(function PlanCard\(/);
  assert.match(source, /function TaskNode\(/);

  // parentPlan / childPlanIds may still exist on the stored Goal Thread,
  // but the card and task detail no longer surface that hierarchy.
  assert.doesNotMatch(source, /子目标 · 来自/);
  assert.doesNotMatch(source, /Child goal · From/);
  assert.doesNotMatch(source, /派生子目标/);
  assert.doesNotMatch(source, /Derived goals/);
  assert.doesNotMatch(source, /goal-plan-origin/);
  assert.doesNotMatch(source, /goal-task-child-plan/);
  assert.doesNotMatch(source, /parentPlan\s*[?:]/);
  assert.doesNotMatch(source, /childPlans/);
  assert.doesNotMatch(source, /task\.childPlanIds/);
  assert.doesNotMatch(source, /onNavigateToPlan/);

  assert.doesNotMatch(styles, /goal-plan-origin/);
  assert.doesNotMatch(styles, /goal-task-child-plan/);
  assert.doesNotMatch(styles, /子目标 · 来自/);
  assert.doesNotMatch(styles, /派生子目标/);
});

test('GoalPlanPanel shows merge route and lamp copy without waiting for acceptance', async () => {
  const source = await readSource();
  const styles = await readStyles();

  assert.match(source, /formatGoalDeliveryHandoffLamp/);
  assert.match(source, /goal-plan-merge-route/);
  assert.match(source, /goal-panel-toggle-active-handoff/);
  assert.match(source, /goal-plan-head-handoff/);
  assert.match(source, /canMergeIntoSource/);
  assert.match(source, /再试一次，合并进 \$\{mergeDest\}/);
  assert.match(source, /合并进 \$\{mergeDest\}/);
  assert.doesNotMatch(source, /重试交回/);
  assert.doesNotMatch(source, /交回未完成/);

  assert.match(styles, /\.goal-plan-merge-route/);
  assert.match(styles, /\.goal-panel-toggle-active-handoff/);
  assert.match(styles, /\.goal-plan-head-handoff/);
});
