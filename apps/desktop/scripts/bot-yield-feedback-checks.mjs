import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCENARIO = 'RC_YIELD_PROGRESS';
const OPENING = '我先核对这项工作的最新进展。';
const ANSWER = '最新记录已核对，目前等待稳定源码后补完验收，无需重复授权。';

/** Controlled cognition at the existing service seam; real Runner yield, storage and UI. */
export async function runYieldFeedbackFixture({ input, active, commandFile, record, phaseTimeoutMs }) {
  const guard = input.executionBudget?.guard;
  assert.ok(guard, 'yield scenario uses the normal durable work budget');
  guard.beforeRequest({ accounting: 'physical_dispatch' });
  const saved = input.executionBudget.providerCheckpoint;
  const send = (channel, payload) => input.webContents.send(channel, { streamId: input.streamId, ...payload });
  const checkpoint = results => ({ provider: 'openai', providerId: input.turnProfile.modelSelection.modelProviderId,
    model: input.turnProfile.modelSelection.modelId, messages: [
      { role: 'user', content: SCENARIO },
      ...results.flatMap(({ id, name, args, result }) => [
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
      ]),
    ] });
  if (!saved) {
    send('chat:stream:thinking', { content: 'PRIVATE_YIELD_REASONING' });
    send('chat:stream:delta', { content: OPENING });
    const args = { sessionId: 'rc-yield-session' }, result = { ok: true, status: 'waiting_user' };
    guard.beforeTool({ toolCallId: 'yield-query', capabilityId: 'get_session' });
    send('chat:stream:tool-call', { tool: 'get_session', toolCallId: 'yield-query', args });
    send('chat:stream:tool-result', { toolCallId: 'yield-query', result: JSON.stringify(result) });
    const native = checkpoint([{ id: 'yield-query', name: 'get_session', args, result }]);
    guard.checkpoint(native, [{ call: { toolCallId: 'yield-query' }, result, terminalReason: 'completed' }]);
    input.executionBudget.onYield(native);
    record('turns', { kind: 'yield-feedback', stage: 'yielded', streamId: input.streamId });
    return { terminalStatus: 'done' };
  }
  assert.ok(saved.messages.some(message => message.role === 'tool' && message.tool_call_id === 'yield-query'));
  record('turns', { kind: 'yield-feedback', stage: 'resumed', streamId: input.streamId });
  const turn = { aborted: false }; active.set(input.streamId, turn);
  try {
    const deadline = Date.now() + phaseTimeoutMs;
    while (Date.now() < deadline && !turn.aborted) {
      const command = JSON.parse(readFileSync(commandFile, 'utf8'));
      if (command.scenario === SCENARIO && command.phase >= 1) {
        const args = { text: ANSWER, replyTo: input.turnProfile.context.inputAnchors.map(anchor => anchor.messageId) };
        guard.beforeTool({ toolCallId: 'yield-answer', capabilityId: 'post_reply' });
        send('chat:stream:tool-call', { tool: 'post_reply', toolCallId: 'yield-answer', args });
        guard.checkpoint(checkpoint([{ id: 'yield-answer', name: 'post_reply', args, result: { ok: true } }]),
          [{ call: { toolCallId: 'yield-answer' }, result: { ok: true }, terminalReason: 'completed' }]);
        send('chat:stream:tool-result', { toolCallId: 'yield-answer', result: JSON.stringify({ ok: true }) });
        return { terminalStatus: 'done' };
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { ok: false, terminalStatus: turn.aborted ? 'aborted' : 'error', error: 'Controlled yield was not advanced' };
  } finally { active.delete(input.streamId); }
}

export async function checkBotYieldFeedback({ page, until, report, captureDirectory, advance, readFixtureTurns }) {
  advance(SCENARIO, 0);
  const composer = page.locator('.bot-composer textarea');
  await composer.fill(SCENARIO);
  await composer.press('Enter');
  await until(() => readFixtureTurns().some(turn => turn.kind === 'yield-feedback' && turn.stage === 'resumed'), Boolean);
  const opening = page.locator('.bot-thread').getByText(OPENING, { exact: true });
  await opening.waitFor();
  assert.equal(await opening.count(), 1, 'persisted opening survives the next scheduling slice');
  assert.equal(await page.locator('.bot-stop-response').count(), 1, 'actual resumed reply remains stoppable');
  assert.equal(await page.locator('.bot-live-reply .bot-reply-bar').count(), 0, 'another slice does not invent a user-selected quote');
  assert.equal(await page.locator('.bot-thread').getByText('PRIVATE_YIELD_REASONING', { exact: true }).count(), 0);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const [width, appearance] of [[1280, 'dark'], [760, 'light']]) {
    await page.setViewportSize({ width, height: 780 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, appearance);
    await opening.scrollIntoViewIfNeeded();
    assert.equal(await opening.isVisible(), true);
    assert.equal(await page.locator('.bot-thread').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `yield-feedback-${width}-${appearance}.png`) });
  }
  advance(SCENARIO, 1);
  await page.locator('.bot-thread').getByText(ANSWER, { exact: true }).waitFor();
  await until(() => page.locator('.bot-stop-response').count(), count => count === 0);
  assert.equal(await opening.count(), 1, 'final answer does not drop or duplicate the earlier public paragraph');
  await page.setViewportSize(viewport);
  await page.evaluate(value => { if (value === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value; }, theme);
  report.yieldFeedback = { passed: true, source: 'real Runner cooperative yield and persisted publicUpdates',
    controlledCognition: true, openingPreserved: true, privateReasoningHidden: true, canonicalReplyDelivered: true };
}
