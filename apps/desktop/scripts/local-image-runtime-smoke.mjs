/** Run with Electron from repo root, or embed as the entry of an isolated packaged candidate. */
import assert from 'node:assert/strict';
import { app, nativeImage } from 'electron';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { basename } from 'node:path';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'peer-image-smoke-')));
process.env.PEER_AGENT_HOME = home;
process.env.PEER_AGENT_DISABLE_LEGACY_MIGRATION = '1';
app.setPath('userData', join(home, 'chromium'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
const source = process.env.PEER_IMAGE_SMOKE_SOURCE || resolve(import.meta.dirname, '..');
const load = path => import(pathToFileURL(join(source, path)).href);
let report;
try {
  const { createRuntimeToolProjection } = await load('electron/main/tools/index.mjs');
  const { createToolContext, executeModelToolCall } = await load('electron/main/chat-runtime/tool-orchestrator.mjs');
  const { createOpenAIVisualObservationMessage, createAnthropicToolResultContent, createGeminiVisualObservationParts } = await load('electron/main/chat-runtime/visual-observation-projection.mjs');
  const { encodeOpenAIResponsesRequest } = await load('electron/main/provider-encoders/responses-encoder.mjs');
  const { createGoalPlanStore } = await load('electron/main/goal-plan-store.mjs');
  const { getDesktopPreviewService } = await load('electron/main/runtime-gateway/desktop-preview-service.mjs');
  const { checkpointWithoutLocalImagePixels } = await import('@peer-agent/runtime-node');
  const projection = createRuntimeToolProjection({ projectionOptions: { mode: 'chat', readOnlyWorkSession: true } });
  assert.ok(projection.registry.getTool('view_image'));
  assert.equal(getDesktopPreviewService(), null);
  const store = createGoalPlanStore({ storeDir: join(home, 'plans') });
  const context = { ...createToolContext({ workspacePath: home, conversationId: 'image-smoke' }), supportsVision: true };
  let asks = 0;
  const permissionGate = {
    createFilePermissionRequester: () => async () => { throw new Error('Image must use capability permission, not file-write approval'); },
    createLocalCapabilityPermissionRequester: () => async () => { asks++; return { granted: true }; },
    createShellApprovalDecider: () => async () => ({ approved: true }),
  };
  const results = [];
  for (const [i, rgba] of [[0, [0, 0, 255, 255]], [1, [0, 255, 0, 255]]]) {
    const image = nativeImage.createFromBitmap(Buffer.from(Array(4).fill(rgba).flat()), { width: 2, height: 2 });
    const file = join(home, `screenshot-${i}.png`); await writeFile(file, image.toPNG());
    const execution = await executeModelToolCall({ name: 'view_image', rawArguments: JSON.stringify({ path: file }), toolCallId: `image-${i}`,
      workspacePath: home, toolContext: context, permissionGate, webContents: { send() {} }, streamId: 'image-stream',
      conversationId: 'image-smoke', registry: projection.registry, runtimeProjection: projection.projection, goalPlanStore: store });
    assert.equal(execution.result.execution.result.status, 'success', JSON.stringify(execution.result));
    assert.equal(execution.visualObservations.length, 1);
    const observation = execution.visualObservations[0];
    const expected = (await readFile(file)).toString('base64');
    const executions = [{ call: { name: 'view_image', toolCallId: `image-${i}` }, result: execution }];
    const message = createOpenAIVisualObservationMessage(executions);
    assert.equal(message.content[1].image_url.url, `data:image/png;base64,${expected}`);
    assert.equal(encodeOpenAIResponsesRequest({ model: 'fixture-vision', messages: [message], tools: [] }).input[0].content[1].type, 'input_image');
    assert.equal(createAnthropicToolResultContent(execution).at(-1).source.data, expected);
    assert.equal(createGeminiVisualObservationParts(executions).at(-1).inlineData.data, expected);
    assert.doesNotMatch(JSON.stringify(checkpointWithoutLocalImagePixels([message])), /base64|iVBOR/);
    assert.doesNotMatch(execution.output, /base64|iVBOR/);
    assert.doesNotMatch(JSON.stringify(execution), /base64|iVBOR/);
    const evidence = createGoalPlanStore({ storeDir: join(home, 'plans') }).findEvidenceIndexRecords([`tool-result://image-${i}`])[0];
    assert.ok(evidence); assert.doesNotMatch(JSON.stringify(evidence), /base64|iVBOR/);
    results.push({ path: file, sha256: observation.sha256, width: observation.width, height: observation.height });
  }
  assert.notEqual(results[0].sha256, results[1].sha256);
  assert.equal(asks, 0);
  const baseImage = nativeImage.createFromBitmap(Buffer.from([0, 255, 0, 255]), { width: 1, height: 1 });
  const formats = [
    ['jpeg', baseImage.toJPEG(80)],
    ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')],
    ['webp', Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')],
  ];
  for (const [format, bytes] of formats) {
    const file = join(home, `format.${format}`); await writeFile(file, bytes);
    const result = await executeModelToolCall({ name: 'view_image', rawArguments: JSON.stringify({ path: file }), toolCallId: `format-${format}`,
      workspacePath: home, toolContext: context, permissionGate, webContents: { send() {} }, streamId: 'image-format', conversationId: 'image-smoke', registry: projection.registry, runtimeProjection: projection.projection, goalPlanStore: store });
    assert.equal(result.result.execution.result.status, 'success', `${format}: ${JSON.stringify(result.result)}`);
    assert.equal(result.visualObservations[0].mediaType, `image/${format}`);
  }
  // Scripted cognition verifies the actual next HTTP request, then writes its
  // fixture review through the ordinary write_file capability. No real model judgment is claimed.
  const { agentLoopOpenAI } = await load('electron/main/chat-runtime/openai-agent-loop.mjs');
  const plan = store.createGoalContract({ conversationId: 'image-smoke', title: 'Image packet review', goal: 'Review two fixture screenshots', successCriteria: ['Read real pixels and write review'], tasks: [{ taskId: 'review', title: 'Review', status: 'pending' }] });
  store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'fixture' });
  store.setRunnerState(plan.planId, { enabled: true, status: 'running', runId: 'image-run', currentTaskId: 'review' });
  context.mode = 'goal'; context.planId = plan.planId;
  context.goalRuntime = { planId: plan.planId, runId: 'image-run', currentTaskId: 'review' };
  const active = createRuntimeToolProjection({ projectionOptions: { mode: 'goal' } });
  const events = [], checkpoints = [];
  let requests = 0, requestImages = 0;
  const reviewFile = join(home, 'review.json');
  const qaSource = process.env.PEER_IMAGE_QA_SOURCE || resolve(source, '../..');
  const { sourceFingerprint, verifyReview } = await import(pathToFileURL(join(qaSource, 'scripts/product-regression.mjs')).href);
  const packet = { schemaVersion: 1, runId: 'synthetic-image-packet', sourceFingerprint: sourceFingerprint(qaSource),
    screenshots: results.map(shot => ({ id: basename(shot.path), path: basename(shot.path), sha256: shot.sha256 })),
    limits: ['Synthetic pixels and scripted cognition; no real-model or product design acceptance.'] };
  const review = { schemaVersion: 1, runId: packet.runId, sourceFingerprint: packet.sourceFingerprint,
    reviewer: { kind: 'ai', name: 'scripted cognition fixture (not a real model)', independent: false }, findings: [],
    screenshots: packet.screenshots.map((shot, i) => ({ ...shot, verdict: 'pass', notes: `Actual 2 by 2 bitmap with uniform ${i === 0 ? 'red' : 'green'} pixels was received.` })) };
  const server = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); requests++;
      let delta, reason;
      if (requests === 1) {
        assert.ok(body.tools.some(tool => tool.function?.name === 'view_image'));
        delta = { tool_calls: results.map((shot, index) => ({ index, id: `model-image-${index}`, type: 'function', function: { name: 'view_image', arguments: JSON.stringify({ path: shot.path }) } })) };
        reason = 'tool_calls';
      } else if (requests === 2) {
        const urls = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []);
        assert.equal(urls.length, 2); requestImages = urls.length;
        for (const [i, url] of urls.entries()) {
          assert.equal(url.split(',')[1], (await readFile(results[i].path)).toString('base64'));
          const bitmap = nativeImage.createFromBuffer(Buffer.from(url.split(',')[1], 'base64')).toBitmap();
          assert.deepEqual([...bitmap.subarray(0, 4)], i === 0 ? [0, 0, 255, 255] : [0, 255, 0, 255]);
        }
        delta = { tool_calls: [{ index: 0, id: 'model-review', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: reviewFile, content: JSON.stringify(review) }) } }] };
        reason = 'tool_calls';
      } else {
        assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'model-review'));
        delta = { content: 'The two fixture images were inspected and the review file was written.' }; reason = 'stop';
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500); response.end(error.stack); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await agentLoopOpenAI({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'isolated-fixture', model: 'fixture-vision', systemPrompt: 'Inspect the two fixture screenshots and write the fixture review.',
      messages: [{ role: 'user', content: 'Read the screenshots and review their pixels.' }], tools: active.modelProjection.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      webContents: { send: (channel, payload) => events.push({ channel, payload }) }, streamId: 'image-loop', conversationId: 'image-smoke',
      workspacePath: home, toolContext: context, permissionGate, registry: active.registry, runtimeProjection: active.projection, goalPlanStore: store,
      runtimeMode: 'goal',
      executionBudget: { maxTurns: 5, guard: { beforeRequest() {}, beforeTool() {}, observeUsage() {}, checkpoint: native => checkpoints.push(native) } },
    });
    assert.equal(requests, 3); assert.equal(requestImages, 2);
    assert.ok(events.some(event => event.channel === 'chat:stream:done'), JSON.stringify(events));
    assert.ok(events.some(event => event.channel === 'chat:stream:tool-result' && event.payload.toolCallId === 'model-review' && !/"status":\s*"(?:denied|failed)"/.test(event.payload.result)), JSON.stringify(events.filter(event => event.channel === 'chat:stream:tool-result')));
    const savedReview = await readFile(reviewFile, 'utf8').catch(error => { throw new Error(JSON.stringify(events.filter(event => event.channel === 'chat:stream:tool-result')), { cause: error }); });
    assert.deepEqual(JSON.parse(savedReview), review);
    const verified = verifyReview({ root: qaSource, output: home, packet, review: JSON.parse(savedReview) });
    assert.equal(verified.status, 'passed');
    assert.throws(() => verifyReview({ root: qaSource, output: home, packet, review: { ...review, screenshots: review.screenshots.slice(1) } }), /Incomplete/);
    const original = await readFile(results[0].path);
    await writeFile(results[0].path, Buffer.concat([original, Buffer.from('changed')]));
    assert.throws(() => verifyReview({ root: qaSource, output: home, packet, review }), /Screenshot/);
    await writeFile(results[0].path, original);
    assert.doesNotMatch(JSON.stringify(checkpoints), /base64|iVBOR/);
    assert.match(JSON.stringify(checkpoints), /Re-read/);
    const reread = await executeModelToolCall({ name: 'view_image', rawArguments: JSON.stringify({ path: results[0].path }), toolCallId: 'image-re-read', workspacePath: home, toolContext: context, permissionGate, webContents: { send() {} }, streamId: 'image-re-read', conversationId: 'image-smoke', registry: active.registry, runtimeProjection: active.projection, goalPlanStore: store });
    assert.equal(reread.visualObservations?.length, 1, 'Completed image ledger entries must not replace fresh pixels with refs');
  } finally { await new Promise(resolve => server.close(resolve)); }
  report = { passed: true, packaged: app.isPackaged, actualDecoder: 'Electron nativeImage + sandboxed Chromium bitmap', formats: ['PNG', 'JPEG', 'GIF', 'WebP'], governedImageCount: results.length, nextHttpRequestImages: requestImages, modelRequests: requests, reviewWrittenThroughTool: true, syntheticPacketVerified: true, incompleteOrChangedPacketRejected: true, checkpointPixelsPersisted: false, completedImageReRead: true, wires: ['OpenAI Chat/Qoder', 'OpenAI Responses', 'Anthropic', 'Gemini'], images: results, personalDataUsed: false, realModel: false };
  console.log(JSON.stringify(report));
  if (process.env.PEER_IMAGE_SMOKE_REPORT) await writeFile(process.env.PEER_IMAGE_SMOKE_REPORT, JSON.stringify(report, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await rm(home, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}

}).catch(error => { console.error(error); app.exit(1); });
