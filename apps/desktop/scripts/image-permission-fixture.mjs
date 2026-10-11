import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Controlled cognition only. Calls the actual projection/host/permission gate and
 * Electron image decoder; neither approval cards nor tool results are injected.
 */
export async function withImagePermissionFixture(service, { mainRoot, imageRoot, receiptFile }) {
  const { createChatPermissionGate } = await import(pathToFileURL(path.join(mainRoot, 'chat-runtime/permission-gate.mjs')).href);
  const { executeModelToolCall, createToolContext } = await import(pathToFileURL(path.join(mainRoot, 'chat-runtime/tool-orchestrator.mjs')).href);
  const { createRuntimeToolProjection } = await import(pathToFileURL(path.join(mainRoot, 'tools/index.mjs')).href);
  const { nativeImage } = await import('electron');
  const original = service.sendMessage.bind(service), originalAbort = service.abort.bind(service);
  const running = new Map(), receipts = [];
  let approvalStore;
  const save = entry => { receipts.push(entry); writeFileSync(receiptFile + '.next', JSON.stringify(receipts)); renameSync(receiptFile + '.next', receiptFile); };
  mkdirSync(imageRoot, { recursive: true }); writeFileSync(receiptFile, '[]');
  return { ...service,
    setApprovalStore: store => { approvalStore = store; },
    abort(id) { running.get(id)?.abort(); originalAbort(id); },
    async sendMessage(input) {
      const message = input.messages?.findLast(row => row.role === 'user')?.content;
      const scenario = typeof message === 'string' ? /RC_IMAGE_(ALLOW|TASK|DENY|CANCEL|STOP|TIMEOUT)/.exec(message)?.[1] : null;
      if (!scenario || input.turnProfile?.role !== 'project_agent') return original(input);
      assert.ok(approvalStore, 'production host must configure its own ApprovalStore');
      const controller = new AbortController(); running.set(input.streamId, controller);
      const streams = new Map([[input.streamId, { turnProfile: input.turnProfile, runtimeTurn: { signal: controller.signal } }]]);
      const gate = createChatPermissionGate({ activeStreams: streams, approvalStore,
        permissionWaitMs: scenario === 'TIMEOUT' ? 2500 : 60_000,
        resolveApprovalScope: () => ({ workspaceId: input.turnProfile.workspaceId, conversationId: input.conversationId }) });
      const image = path.join(imageRoot, `permission-check-${scenario.toLowerCase()}.png`);
      if (!existsSync(image)) writeFileSync(image, nativeImage.createFromBitmap(Buffer.from([90, 80, 220, 255]), { width: 1, height: 1 }).toPNG());
      const expectedHash = createHash('sha256').update(readFileSync(image)).digest('hex');
      const id = `image-${scenario.toLowerCase()}-${randomUUID()}`;
      save({ scenario, stage: 'started', streamId: input.streamId, toolCallId: id, image });
      const observedSink = { send(channel, payload) {
        if (channel === 'chat:stream:tool-result' && payload.toolCallId === id) {
          save({ scenario, stage: 'stream-result', evidence: payload.evidenceRefs?.length > 0,
            cancelled: String(payload.result).includes('permission_cancelled') });
        }
        input.webContents.send(channel, payload);
      } };
      input.webContents.send('chat:stream:delta', { streamId: input.streamId, content: '我先查看这张测试图片。' });
      const context = { ...createToolContext(), turnRole: 'project_agent', workspacePath: input.workspacePath,
        supportsVision: true, readableRoots: [input.workspacePath] };
      const { registry, projection } = createRuntimeToolProjection({ projectionOptions: { mode: 'project_agent', accessLevel: 'restricted_local' } });
      let execution;
      context.onToolExecution = value => { execution = value; };
      try {
        const read = toolCallId => executeModelToolCall({ name: 'view_image', rawArguments: JSON.stringify({ path: image }),
          toolCallId, workspacePath: input.workspacePath, toolContext: context, permissionGate: gate,
          registry, runtimeProjection: projection,
          webContents: observedSink, streamId: input.streamId, conversationId: input.conversationId, signal: controller.signal });
        const result = await read(id);
        const pixels = result.visualObservations?.[0];
        if (pixels) {
          assert.equal(createHash('sha256').update(Buffer.from(pixels.dataUrl.split(',')[1], 'base64')).digest('hex'), expectedHash);
          assert.equal(pixels.width, 1); assert.equal(pixels.height, 1);
          assert.equal(execution.call.capabilityId, 'local.image.read');
          assert.equal(execution.result.status, 'success'); assert.equal(execution.grant.granted, true);
          assert.ok(execution.result.evidence);
        }
        save({ scenario, stage: 'finished', streamId: input.streamId, toolCallId: id,
          status: execution?.result.status ?? (result.aborted ? 'cancelled' : 'unknown'),
          reason: execution?.result.outputPreview?.reason, pixels: Boolean(pixels),
          sha256: pixels?.sha256, grantId: execution?.grant.grantId, evidence: Boolean(execution?.result.evidence), pending: gate.listPendingPermissions().length });
        if (scenario === 'TASK' && pixels) {
          const inherited = await read(id + '-inherited');
          assert.equal(inherited.visualObservations?.[0]?.sha256, expectedHash);
          save({ scenario, stage: 'inherited', pixels: true, grantId: execution.grant.grantId, pending: gate.listPendingPermissions().length });
        }
        if (controller.signal.aborted) return { terminalStatus: 'aborted', text: '' };
        return { terminalStatus: 'done', text: pixels ? '图片已经读取并解码，像素已送入当前回合的视觉上下文。'
          : scenario === 'TIMEOUT' ? '等待授权已超时，本次没有读取图片。'
            : scenario === 'DENY' ? '已拒绝本次图片读取。' : '本次图片读取已取消。' };
      } finally {
        gate.settleStreamPermissionRequests(input.streamId, { granted: false });
        running.delete(input.streamId);
      }
    },
  };
}
