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
  assert.match(source, /goal-panel-toggle-active/);
  assert.match(source, /goal-plan-head-handoff/);
  assert.match(source, /canMergeIntoSource/);
  assert.match(source, /qualityReviewPending/);
  assert.match(source, /mergeIntoSource/);
  assert.match(source, /await clientApi.goalPlansRetryHandoff/);
  assert.match(source, /deliveryHandoff\?\.status === 'stopped'/);
  assert.match(source, /再试一次，合并进 \$\{mergeDest\}/);
  assert.match(source, /合并进 \$\{mergeDest\}/);
  assert.match(source, /qualityReviewPending \? \(/);
  assert.match(source, /isZh \? '继续修' : 'Continue fixing'/);
  assert.match(source, /onNextAction\(plan, 'continue-fix'\)/);
  assert.match(source, /continueFixingMessage\(plan\.planId, isZh\)/);
  assert.match(source, /isZh \? '有未归档' : 'Unarchived remaining'/);
  assert.match(source, /hasUnarchivedHint/);
  assert.doesNotMatch(source, /GoalStripPlanRow/);
  assert.doesNotMatch(source, /goal-panel-toggle-plans/);
  assert.doesNotMatch(source, /goal-panel-toggle-label/);
  assert.doesNotMatch(source, /goal-panel-toggle-summary/);
  assert.doesNotMatch(source, /个目标计划/);
  assert.doesNotMatch(source, /Goal plans/);
  assert.doesNotMatch(source, /qualityReviewPending[\s\S]{0,120}onNextAction\(plan, 'adjust'\)/);
  assert.doesNotMatch(source, /qualityReviewPending[\s\S]{0,80}mergeIntoSource\(\)/);
  assert.doesNotMatch(source, /重试交回/);
  assert.doesNotMatch(source, /交回未完成/);

  // ADR 68：合回路线图只对隔离计划渲染；非隔离（direct）计划不画合回图。
  assert.match(source, /const showMergeRoute = isolated;/);
  assert.doesNotMatch(source, /const showMergeRoute = hasTaskLine\(plan\) \|\| isolated;/);

  assert.match(styles, /\.goal-plan-merge-route/);
  assert.match(styles, /\.goal-panel-toggle-active-handoff/);
  assert.match(styles, /\.goal-plan-head-handoff/);
  assert.doesNotMatch(styles, /\.goal-panel-toggle-plans\b/);
  assert.doesNotMatch(styles, /\.goal-panel-toggle-plan-action\b/);
});

test('goal task list tooltip pins width and wraps titles instead of oscillating ellipsis', async () => {
  const styles = await readStyles();
  const titleBlock = styles.match(
    /\.goal-panel-toggle-progress-tooltip__title \{[\s\S]*?\n\}/,
  )?.[0] ?? '';
  const listBlock = styles.match(
    /\.goal-panel-toggle-progress-tooltip--list \{[\s\S]*?\n\}/,
  )?.[0] ?? '';

  assert.match(
    styles,
    /\.app-tooltip:has\(\.goal-panel-toggle-progress-tooltip--list\) \{/,
  );
  assert.match(styles, /width:\s*min\(320px,\s*calc\(100vw - 24px\)\)/);
  assert.match(listBlock, /width:\s*100%/);
  assert.match(titleBlock, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(titleBlock, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(titleBlock, /white-space:\s*nowrap/);
});

test('GoalPlanPanel merge gate uses qualityReview instead of stale pending snapshot', async () => {
  const source = await readSource();
  assert.match(source, /isQualityReviewBlockingMerge\(plan\)/);
  assert.doesNotMatch(
    source,
    /const qualityReviewPending = plan\.deliveryHandoff\?\.stoppedReason === 'quality_review_pending'/,
  );
});
