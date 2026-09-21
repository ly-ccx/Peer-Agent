import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { decideIntakeConvergence } from '../../../../packages/runtime-node/src/goal-intake-convergence.mjs';
import { createGoalVisualCompletionHandoff } from './goal-visual-completion-handoff.mjs';

const done = { terminalStatus: 'done' };
function fixture(activation = 'intake') {
  let plan = { planId: 'p', conversationId: 'c', workflowKind: 'goal_self_driven',
    activation: { kind: activation }, status: 'completed', updatedAt: '2', runner: { status: 'idle' },
    tasks: [{ taskId: 'observe', status: 'completed', evidenceRefs: ['tool-result://observe'] }] };
  let required = true;
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const calls = [];
  const store = {
    listPlansByConversation: () => plan ? [{ planId: 'p' }] : [],
    getPlan: id => id === plan?.planId ? plan : null,
    getActivePlanByConversation: () => plan,
  };
  const service = createGoalVisualCompletionHandoff({ goalPlanStore: store,
    authority: { read: () => { if (required === 'throw') throw new Error('ledger invalid'); return { required }; } },
    forceComplete: id => { calls.push(`release:${id}`); return { released }; },
    startRunner: id => { calls.push(`start:${id}`); },
  });
  return { service, calls, store, release, get plan() { return plan; },
    setPlan: next => { plan = next; }, setRequired: next => { required = next; } };
}

for (const activation of ['intake', 'accepted_goal']) {
  for (const outcomeName of ['done', 'requested_user_input', 'error', 'aborted']) {
    for (const wait of ['none', 'paused', 'waiting_user', 'preview-review-pending', 'waiting_permission', 'interruption', 'cancelled']) {
      test(`${activation}/${outcomeName}/${wait}/handoff`, async () => {
        const f = fixture(activation);
        if (wait === 'interruption') f.plan.runner.interruption = { source: 'stream_interrupted' };
        else if (wait === 'cancelled') f.plan.status = 'cancelled';
        else if (wait === 'preview-review-pending') {
          f.plan.runner.status = 'waiting_user';
          f.plan.tasks = [{ taskId: 'observe', status: 'completed', evidenceRefs: ['tool-result://observe'] },
            { taskId: 'close', status: 'waiting_user', blockedReason: 'preview-review-pending', evidenceRefs: ['tool-result://close'] }];
        }
        else if (wait !== 'none') f.plan.runner.status = wait;
        const outcome = outcomeName === 'requested_user_input' ? { ...done, requestedUserInput: true }
          : { terminalStatus: outcomeName };
        const pending = f.service.handoff('c', outcome, 'p');
        assert.equal(f.calls.some(x => x.startsWith('start')), false, 'must wait for release');
        f.release();
        const expected = outcomeName === 'done' && (wait === 'none' || wait === 'preview-review-pending');
        assert.equal(await pending, expected);
        assert.deepEqual(f.calls, expected ? ['release:c', 'start:p'] : []);
        assert.equal(f.plan.activation.kind, activation, 'no silent promotion');
      });
    }
  }
}

for (const wait of ['mixed-user-leaf', 'persisted-request']) {
  test(`foreground/${wait}/preview-does-not-override-user`, async () => {
    const f = fixture();
    f.plan.tasks.push({ taskId: 'close', status: 'waiting_user', blockedReason: 'preview-review-pending' });
    if (wait === 'mixed-user-leaf') f.plan.tasks.push({ taskId: 'question', status: 'waiting_user', blockedReason: 'choose_destination' });
    else f.plan.runner = { status: 'waiting_user', blockedReason: 'requested_user_input' };
    const pending = f.service.handoff('c', done, 'p');
    f.release();
    assert.equal(await pending, false);
    assert.deepEqual(f.calls, []);
  });
}

for (const mutation of ['paused', 'cancelled', 'interruption', 'deleted', 'conversation', 'non-ui', 'leaf-open']) {
  test(`release/${mutation}/recheck`, async () => {
    const f = fixture();
    const work = f.service.handoff('c', done, 'p');
    if (mutation === 'paused') f.plan.runner.status = 'paused';
    if (mutation === 'cancelled') f.plan.status = 'cancelled';
    if (mutation === 'interruption') f.plan.runner.interruption = {};
    if (mutation === 'deleted') f.setPlan(null);
    if (mutation === 'conversation') f.plan.conversationId = 'other';
    if (mutation === 'non-ui') f.setRequired(false);
    if (mutation === 'leaf-open') f.plan.tasks[0].status = 'pending';
    f.release();
    assert.equal(await work, false);
    assert.deepEqual(f.calls, ['release:c']);
  });
}

test('duplicate pending completion shares one release and Runner start', async () => {
  const f = fixture();
  const a = f.service.handoff('c', done, 'p');
  const b = f.service.handoff('c', done, 'p');
  assert.equal(a, b);
  f.release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.deepEqual(f.calls, ['release:c', 'start:p']);
});

for (const required of [false, 'throw']) {
  test(`authority/${required}/existing gate owns failure`, async () => {
    const f = fixture(); f.setRequired(required); f.release();
    assert.equal(await f.service.handoff('c', done, 'p'), required === 'throw');
    assert.deepEqual(f.calls, required === 'throw' ? ['release:c', 'start:p'] : []);
  });
}

for (const activation of ['intake', 'accepted_goal']) {
  for (const identity of ['bound', 'missing', 'unknown', 'superseded-before', 'superseded-after']) {
    test(`${activation}/${identity}/foreground-plan-identity`, async () => {
      const f = fixture(activation);
      const history = { ...f.plan, planId: 'history', updatedAt: '9' };
      let active = identity === 'superseded-before' ? history : f.plan;
      f.store.listPlansByConversation = () => [history, f.plan];
      f.store.getPlan = id => id === 'history' ? history : id === 'p' ? f.plan : null;
      f.store.getActivePlanByConversation = () => active;
      const id = identity === 'missing' ? undefined : identity === 'unknown' ? 'unknown' : 'p';
      const pending = f.service.handoff('c', done, id);
      if (identity === 'superseded-after') active = history;
      f.release();
      assert.equal(await pending, identity === 'bound');
      assert.deepEqual(f.calls, identity === 'bound' ? ['release:c', 'start:p']
        : identity === 'superseded-after' ? ['release:c'] : []);
    });
  }
}

const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const begin = main.indexOf('function convergeIntakeAfterGoalTurn(');
const end = main.indexOf('\nasync function handleChatStartTask(', begin);
assert.ok(begin >= 0 && end > begin);
for (const outcomeName of ['done', 'requested_user_input', 'error', 'aborted']) {
  test(`actual Desktop convergence/${outcomeName}/keep is not always user wait`, () => {
    const f = fixture();
    const calls = [];
    const context = vm.createContext({ goalPlanStore: { ...f.store,
      markRequestedUserInput: () => calls.push('wait'), setRunnerState: () => calls.push('interrupt'),
      appendIntakeConvergenceAudit: () => {}, deletePlan: () => calls.push('delete') },
      decideIntakeConvergence, console });
    vm.runInContext(`${main.slice(begin, end)}\nthis.converge = convergeIntakeAfterGoalTurn;`, context);
    context.converge('c', outcomeName === 'requested_user_input' ? { ...done, requestedUserInput: true }
      : { terminalStatus: outcomeName });
    assert.deepEqual(calls, outcomeName === 'done' ? [] : outcomeName === 'requested_user_input' ? ['wait'] : ['interrupt', 'wait']);
  });
}

test('Desktop foreground binds plan identity before send and keeps it through outcome', async () => {
  let active = { planId: 'foreground' };
  let resolveOutcome;
  const outcomePromise = new Promise(resolve => { resolveOutcome = resolve; });
  const calls = [];
  const context = vm.createContext({
    conversationId: 'c', resumeInterruptedReply: false, mode: 'chat', answeredRequestedUserInputPlanId: null,
    goalPlanStore: { getActivePlanByConversation: () => active },
    llmChatService: { sendMessage: () => outcomePromise },
    visualCompletionHandoff: { handoff: (...args) => { calls.push(args); return Promise.resolve(true); } },
    convergeIntakeAfterGoalTurn: () => calls.push('converged'),
    shouldRearmStalledAcceptedGoalRunner: () => false,
    shouldAutoStartAcceptedGoalRunner: () => false,
    shouldRecoverAcceptedGoalRunnerOnConversationOpen: () => false,
    console,
  });
  // Execute both production composition slices; only provider payload is omitted.
  const bindingStart = main.indexOf('  const visualCompletionPlanId =');
  const sendStart = main.indexOf('  const outcomePromise = llmChatService.sendMessage(', bindingStart);
  const outcomeStart = main.indexOf('  if (!resumeInterruptedReply && (mode ===', sendStart);
  const outcomeEnd = main.indexOf('\n  return outcomePromise;', outcomeStart);
  assert.ok(bindingStart >= 0 && sendStart > bindingStart && outcomeEnd > outcomeStart);
  vm.runInContext(`this.run = async () => { ${main.slice(bindingStart, sendStart)}
    const outcomePromise = llmChatService.sendMessage({});
    ${main.slice(outcomeStart, outcomeEnd)} };`, context);
  const pending = context.run();
  active = { planId: 'newer-plan' };
  resolveOutcome(done);
  assert.equal(await pending, done);
  assert.deepEqual(calls, ['converged', ['c', done, 'foreground']]);
});

for (const [isPackaged, isManagedPreview] of [[false, false], [false, true], [true, false]]) {
  test(`Desktop store UI port/${isPackaged}/${isManagedPreview}/composition`, () => {
    const begin = main.indexOf('const goalPlanStore = createGoalPlanStore(');
    const end = main.indexOf('  // 任何写路径', begin);
    assert.ok(begin >= 0 && end > begin);
    const calls = [];
    const context = vm.createContext({ isPackaged, isManagedPreview,
      readDesktopWorkspaceHead: () => {}, createGoalPlanStore: options => options,
      desktopPreviewProvider: { authority: { read: (...args) => { calls.push(args); return { required: false }; } } } });
    vm.runInContext(`${main.slice(begin, end)} }); this.options = goalPlanStore;`, context);
    const enabled = !isPackaged && !isManagedPreview;
    assert.equal(typeof context.options.readUiDelivery === 'function', enabled);
    if (enabled) {
      const plan = { planId: 'p' };
      context.options.readUiDelivery(plan);
      assert.deepEqual(calls, [['p', plan]], 'full candidate must reach authority without recursive getPlan');
    }
  });
}

test('actual Desktop composition uses the exported release port', async () => {
  const f = fixture();
  const calls = [];
  const start = main.indexOf('const visualCompletionHandoff = createGoalVisualCompletionHandoff(');
  const finish = main.indexOf('\ngoalRunner = createGoalRunner(', start);
  assert.ok(start >= 0 && finish > start);
  const context = vm.createContext({ createGoalVisualCompletionHandoff,
    goalPlanStore: f.store, desktopPreviewProvider: { authority: { read: () => ({ required: true }) } },
    llmChatService: { forceCompleteConversationStreams: (id, options) => {
      calls.push(['release', id, options.reason]); return { released: Promise.resolve() };
    } }, goalRunner: { start: id => { calls.push(['start', id]); } },
  });
  vm.runInContext(`${main.slice(start, finish)}\nthis.service = visualCompletionHandoff;`, context);
  assert.equal(await context.service.handoff('c', done, 'p'), true);
  assert.deepEqual(calls, [['release', 'c', 'goal-visual-completion-handoff'], ['start', 'p']]);
  const llm = readFileSync(new URL('./llm-chat-service.mjs', import.meta.url), 'utf8');
  assert.match(llm, /function forceCompleteConversationStreams\(/);
  assert.match(llm, /\n    forceCompleteConversationStreams,/);
});
