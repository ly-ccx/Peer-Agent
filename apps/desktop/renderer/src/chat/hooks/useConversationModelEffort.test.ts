import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ConversationStore } from '../state/conversationStore.ts';
import { isEffortLevel, type EffortLevel } from '../state/preferences.ts';
import type { ConversationModelEffort } from './useConversationModelEffort';

type ModelEffortWrite = { id: string; effort?: EffortLevel; modelProviderId?: string | null };

const hook = ts.transpileModule(
  readFileSync(new URL('./useConversationModelEffort.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(
  persist: (patch: ModelEffortWrite) => Promise<unknown>,
  persistSettings: () => Promise<unknown> = async () => ({}),
) {
  const store = new ConversationStore();
  const writes: ModelEffortWrite[] = [];
  const seeds: EffortLevel[] = [];
  const remembered: string[] = [];
  const modules: Record<string, unknown> = {
    react: {
      useCallback: (callback: unknown) => callback,
      useRef: (current: unknown) => ({ current }),
    },
    '../../clientApi': { clientApi: {
      conversationsUpdateModelEffort: (patch: ModelEffortWrite) => {
        writes.push({ ...patch });
        return persist(patch);
      },
      updateSettings: ({ effort }: { effort: EffortLevel }) => {
        seeds.push(effort);
        return persistSettings();
      },
    } },
    '../state/conversationStore': { conversationStore: store },
    './useConversationState': {
      useConversationState: (id: string | null) => ({ state: store.getSnapshot(id) }),
    },
    '../state/preferences': {
      isEffortLevel,
      writeLastModelProviderId: (id: string | undefined) => { if (id) remembered.push(id); },
    },
  };
  const exports = {} as { useConversationModelEffort: (id: string | null) => ConversationModelEffort };
  runInNewContext(hook, { exports, require: (name: string) => {
    assert.ok(name in modules, name);
    return modules[name];
  } });
  return { ...exports, store, writes, seeds, remembered };
}

test('a busy rejection leaves the accepted model, effort, and defaults intact', async () => {
  const input = setup(async () => {
    throw new Error("Error invoking remote method 'conversations:update-model-effort': Error: conversation_execution_busy");
  });
  const model = input.useConversationModelEffort('chat');
  model.setEffort('default');
  model.setModelProviderId('old::model');
  const before = input.store.getSnapshot('chat');

  assert.equal(await model.saveModelEffort({ effort: 'high' }, { passive: true }), false);
  assert.equal(await model.saveModelEffort({ modelProviderId: 'new', effort: 'low' }), false);
  assert.equal(input.store.getSnapshot('chat'), before);
  assert.deepEqual(input.writes, [
    { id: 'chat', effort: 'high' },
    { id: 'chat', modelProviderId: 'new', effort: 'low' },
  ]);
  assert.deepEqual(input.seeds, []);
  assert.deepEqual(input.remembered, []);
});

test('an idle correction commits after acknowledgment and a manual model switch saves both fields', async () => {
  const acknowledgment = deferred<unknown>();
  const input = setup(() => acknowledgment.promise);
  const model = input.useConversationModelEffort('chat');
  model.setModelProviderId('old::model');

  const correction = model.saveModelEffort({ modelProviderId: 'current', effort: 'high' }, { passive: true });
  assert.equal(input.store.getSnapshot('chat').modelProviderId, 'old::model');
  assert.equal(input.store.getSnapshot('chat').effort, 'default');
  assert.deepEqual(input.seeds, []);
  acknowledgment.resolve({ id: 'chat' });
  assert.equal(await correction, true);
  assert.equal(input.store.getSnapshot('chat').modelProviderId, 'current');
  assert.equal(input.store.getSnapshot('chat').effort, 'high');

  assert.equal(await model.saveModelEffort({ modelProviderId: 'next', effort: 'low' }), true);
  assert.equal(input.store.getSnapshot('chat').modelProviderId, 'next');
  assert.equal(input.store.getSnapshot('chat').effort, 'low');
  assert.deepEqual(input.writes, [
    { id: 'chat', modelProviderId: 'current', effort: 'high' },
    { id: 'chat', modelProviderId: 'next', effort: 'low' },
  ]);
  assert.deepEqual(input.seeds, ['high', 'low']);
  assert.deepEqual(input.remembered, ['current', 'next']);
});

test('manual changes follow the pending write and stale passive corrections are skipped', async () => {
  const acknowledgment = deferred<unknown>();
  const input = setup(({ effort }) => effort === 'high' ? acknowledgment.promise : Promise.resolve({ id: 'chat' }));
  const model = input.useConversationModelEffort('chat');

  const correction = model.saveModelEffort({ effort: 'high' }, { passive: true });
  const manual = model.saveModelEffort({ effort: 'low' });
  assert.equal(await model.saveModelEffort({ effort: 'medium' }, { passive: true }), false);
  assert.deepEqual(input.writes, [{ id: 'chat', effort: 'high' }]);
  acknowledgment.reject(new Error('conversation_execution_busy'));
  assert.equal(await correction, false);
  assert.equal(await manual, true);
  assert.equal(input.store.getSnapshot('chat').effort, 'low');
  assert.deepEqual(input.seeds, ['low']);
});

test('a draft changes locally even when writing the default settings fails', async () => {
  const input = setup(async () => assert.fail('drafts have no conversation metadata'), async () => {
    throw new Error('settings unavailable');
  });
  const draft = input.useConversationModelEffort('draft-selection');
  assert.equal(await draft.saveModelEffort({ effort: 'high' }), true);
  assert.equal(input.store.getSnapshot('draft-selection').effort, 'high');
  assert.deepEqual(input.seeds, ['high']);
  assert.deepEqual(input.writes, []);
});
