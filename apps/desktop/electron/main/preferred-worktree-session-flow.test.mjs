import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('new-task worktree preference is stored on the conversation and applied via isolatePlan', async () => {
  const [main, service, helper, adapter] = await Promise.all([
    readSource('./main.mjs'),
    readSource('./llm-chat-service.mjs'),
    readSource('./goal-preferred-worktree.mjs'),
    readSource('./goal-worktree-adapter.mjs'),
  ]);

  assert.match(main, /handleChatStartTask\([\s\S]*preferredExecutionIsolation = 'none'[\s\S]*createConversation\(\{[\s\S]*preferredExecutionIsolation/);
  assert.match(main, /originWorkspacePath: conversationWorkspacePath,\s*targetWorkspacePath: conversationWorkspacePath/);
  assert.match(main, /prepareIsolation: async \(plan\) => \{[\s\S]*preparePlanExecutionWorkspace/);
  assert.match(service, /preparePlanExecutionWorkspace\(\{[\s\S]*isolatePlan: goalWorktreeAdapter\?\.isolatePlan/);
  assert.match(helper, /conversationPrefersWorktree/);
  assert.match(helper, /isolatePlan/);
  assert.match(adapter, /async function isolatePlan/);
  assert.doesNotMatch(helper, /executionIsolation: 'worktree'/);
});
