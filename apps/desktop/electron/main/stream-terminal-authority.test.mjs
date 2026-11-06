import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { createConversationStore } from '../../../../packages/conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../../../../packages/runtime-node/src/goal-plan-store.mjs';
import { createProjectGoalRunnerHost } from '../../../../packages/runtime-node/src/project-agent/goal-runner-host.mjs';

// Exercise the real router callbacks and state store; only the React lifecycle,
// animation clock and IPC boundary are adapted. No desktop app is started.
function routerHarness(onReplace) {
  const effects = [], cleanups = [], events = new Map(), cache = new Map();
  const require = createRequire(import.meta.url);
  const api = new Proxy({}, { get(_target, key) {
    if (key === 'conversationsReplaceMessages') return args => { onReplace(args); return Promise.resolve(); };
    if (String(key).startsWith('on')) return callback => { events.set(key, callback); return () => events.delete(key); };
    return () => Promise.resolve(null);
  } });
  const react = { useRef: current => ({ current }), useCallback: fn => fn,
    useEffect: fn => effects.push(fn), useLayoutEffect: fn => effects.push(fn) };
  const load = file => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(source, { module, exports: module.exports, console, setTimeout, clearTimeout, setInterval, clearInterval,
      performance, Date, Map, Set, AbortController, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      window: { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} },
      require(id) {
        if (id === 'react') return react;
        if (id.endsWith('/clientApi')) return { clientApi: api };
        if (id === './useTypewriterStream') return { useTypewriterStream: () => ({ push() {}, flush() {}, reset() {} }), THINKING_TYPEWRITER_OPTIONS: {}, VISIBLE_TYPEWRITER_OPTIONS: {} };
        if (!id.startsWith('.')) return require(id);
        const full = path.resolve(path.dirname(file), id), target = [full, full + '.ts', full + '.tsx'].find(existsSync);
        if (!target) throw Error('Unexpected test dependency ' + id);
        return load(target);
      },
    }, { filename: file });
    return module.exports;
  };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../renderer/src/chat');
  const store = load(path.join(root, 'state/conversationStore.ts')).conversationStore;
  load(path.join(root, 'hooks/useConversationStreamRouter.ts')).useConversationStreamRouter({ activeConversationId: 'other' });
  for (const fn of effects) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); }
  return { store, emit: (name, payload) => { assert.ok(events.has(name), name); events.get(name)(payload); },
    close: () => cleanups.reverse().forEach(fn => fn()) };
}

for (const channel of ['onChatStreamDone', 'onChatStreamAborted', 'onChatStreamError']) test(`a late ${channel} projection cannot erase the next Goal Host placeholder before its real terminal commit`, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-terminal-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const convo = store.createConversation({ title: 'fixture' });
  const user = { id: 'user', role: 'user', content: 'continue' }, old = { id: 'old', role: 'assistant', content: '' };
  store.appendMessage(convo.id, user); store.appendMessage(convo.id, old);
  await store.commitStreamingMessage(convo.id, 'old', { interrupted: true, content: '' });
  const queued = [], ui = routerHarness(args => queued.push(args)); t.after(ui.close);
  ui.store.routeStream('old-stream', convo.id);
  ui.store.setState(convo.id, { messages: [user, old], streamId: 'old-stream', isStreaming: true, draft: 'retain draft' });
  ui.emit(channel, { streamId: 'old-stream', conversationId: convo.id, error: 'provider_error' });
  const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
  const plan = plans.createPlan({ conversationId: convo.id, title: 'continue', goal: 'continue', tasks: [{ taskId: 't', title: 'work', status: 'pending' }] });
  plans.recordApproval(plan.planId, { decision: 'approve' });
  let turns = 0, messageId;
  const host = createProjectGoalRunnerHost({ goalPlanStore: plans, conversationStore: store, llmChatService: {}, broadcast() {},
    resolveConversationModelProviderId: () => 'fixture', toDesktopProviderMessages: rows => rows, desktopContinuityContextFromProjection: () => [],
    agentTurnExecutor: { async runTurn(input) {
      turns++; messageId = input.assistantMessageId;
      assert.ok(store.getConversation(convo.id).messages.some(row => row.id === messageId));
      // A renderer IPC write can arrive after the next host has already appended.
      for (const args of queued) store.replaceMessages(args.id, args.messages);
      store.patchStreamingMessage(convo.id, messageId, { content: 'retained result' });
      await store.commitStreamingMessage(convo.id, messageId, { content: 'retained result' });
      return { requestedUserInput: true, terminalStatus: 'done' };
    } } });
  await host.goalRunner.start(plan.planId, { awaitIdle: true });
  assert.equal(queued.length, 0, 'terminal UI projection cannot write a complete conversation snapshot');
  assert.equal(turns, 1); assert.equal(ui.store.getSnapshot(convo.id).draft, 'retain draft');
  assert.equal(store.getPersistedConversationHistory(convo.id).messages.find(row => row.id === messageId)?.content, 'retained result');
});
