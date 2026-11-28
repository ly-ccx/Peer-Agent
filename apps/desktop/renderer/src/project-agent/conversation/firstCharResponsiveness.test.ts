import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/clientApi')) {
      return { url: 'data:text/javascript,export const clientApi = { getSettings: async () => ({}) };', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { inputPredictionPreferences, publishInputPredictionPreferences } = await import('../../chat/state/inputPredictionPreferences.ts');

const readSource = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');

test('TaskWorkspaceView isolates follow-up text in a memoized leaf and memoizes ConversationSceneDrawer', async () => {
  const [workspace, scene, inspector, touchBar] = await Promise.all([
    readSource('../task-workspace/TaskWorkspaceView.tsx'),
    readSource('../drawer/ConversationScene.tsx'),
    readSource('../task-workspace/TaskEvidenceInspector.tsx'),
    readSource('./ComposerTouchBar.tsx'),
  ]);

  assert.match(workspace, /const TaskFollowUpComposer = memo\(function TaskFollowUpComposer/);
  const workspaceMainBody = workspace.split('export function TaskWorkspaceView')[1] ?? '';
  assert.doesNotMatch(
    workspaceMainBody,
    /useState\(''\)|setFollowUpText/,
    'TaskWorkspaceView root must not hold per-keystroke followUpText state',
  );
  assert.match(workspaceMainBody, /<TaskFollowUpComposer[\s\S]*?onFeedback=\{setFeedback\}/);
  assert.match(workspaceMainBody, /task=\{sceneTask\}/);
  assert.match(workspaceMainBody, /onClose=\{handleBackFromScene\}/);
  assert.match(scene, /export const ConversationSceneDrawer = memo\(function ConversationSceneDrawer/);
  assert.match(inspector, /export const TaskEvidenceInspector = memo\(function TaskEvidenceInspector/);
  assert.match(touchBar, /export const ComposerTouchBar = memo\(function ComposerTouchBar/);
});

test('BotConversationComposer isolates draft updates from composer chrome and avoids cloning messages per keystroke', async () => {
  const [composer, access, models, notice] = await Promise.all([
    readSource('./BotConversationComposer.tsx'),
    readSource('../BotAccessControl.tsx'),
    readSource('../BotModelControls.tsx'),
    readSource('./InputRecoveryNotice.tsx'),
  ]);

  assert.match(composer, /const BotComposerDraftBridge = memo\(function BotComposerDraftBridge/);
  assert.match(composer, /useInputRecoveryState\(session,\s*composerStatusKeys\)/);
  assert.match(composer, /useInputRecoveryState\(session,\s*composerDraftKeys\)/);
  assert.doesNotMatch(composer, /\[\.\.\.conversation\.messages\]\.reverse\(\)/);
  assert.match(access, /export const BotAccessControl = memo\(function BotAccessControl/);
  assert.match(models, /export const BotModelControls = memo\(function BotModelControls/);
  assert.match(notice, /export const InputRecoveryNotice = memo\(function InputRecoveryNotice/);
});

test('ComposerInputSuggestion skips layout effects when no candidate is active and BotSelectionQuote shares one document hub', async () => {
  const [suggestion, selectionQuote] = await Promise.all([
    readSource('../../chat/components/ComposerInputSuggestion.tsx'),
    readSource('./BotSelectionQuote.tsx'),
  ]);

  assert.match(suggestion, /export const ComposerInputSuggestion = memo\(function ComposerInputSuggestion/);
  const shellBody = suggestion.split('export const ComposerInputSuggestion')[1] ?? '';
  assert.match(shellBody, /if \(!candidate\) return null;/);
  assert.doesNotMatch(shellBody, /useLayoutEffect/);
  assert.match(selectionQuote, /const quoteEntries = new Set<QuoteEntry>\(\)/);
  assert.match(selectionQuote, /isTextFieldActive\(\)/);
  assert.match(selectionQuote, /if \(!portalMounted && !selected\) return null;/);
});

test('publishInputPredictionPreferences suppresses redundant subscriber notifications on unchanged focus refreshes', () => {
  publishInputPredictionPreferences({ enabled: true, continuationEnabled: true, disabledWorkspaceIds: ['ws-1'] });
  let notifications = 0;
  const off = inputPredictionPreferences.subscribe(() => { notifications += 1; });
  try {
    publishInputPredictionPreferences({ enabled: true, continuationEnabled: true, disabledWorkspaceIds: ['ws-1'] });
    assert.equal(notifications, 0, 'identical preferences must not trigger composer re-render on focus');
    publishInputPredictionPreferences({ enabled: true, continuationEnabled: false, disabledWorkspaceIds: ['ws-1'] });
    assert.equal(notifications, 1, 'changed preferences must still notify subscribers');
  } finally {
    off();
  }
});
