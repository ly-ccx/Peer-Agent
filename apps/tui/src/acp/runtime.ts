import os from 'node:os';
import path from 'node:path';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import { createTuiRuntime } from '../tui-runtime.ts';
import { createChatController } from '../chat-controller.ts';
import { createTuiConversationPersistence } from '../conversation-persistence.ts';
import type { AcpRuntimeFactory } from './agent.ts';
import { createAcpUpdateProjector } from './updates.ts';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { requestAcpApproval } from './permission.ts';
import { createAcpModelConfig } from './models.ts';

/** Reuses the CLI runtime, local PermissionGrant and persisted conversation/Evidence chain. */
export function createAcpRuntimeFactory(requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>): AcpRuntimeFactory {
return async (cwd, update, sessionId) => {
  const runtime = await createTuiRuntime({ workspaceRoot: cwd, userDataPath: path.join(os.homedir(), '.peer-agent'), accessLevel: 'ask_before_local', denyInteractiveTools: true });
  if (!runtime.modelConfig.configured) {
    await runtime.host.dispose();
    throw new Error('Configure a Peer model before creating an ACP session');
  }
  const persistence = createTuiConversationPersistence({ workspacePath: cwd, initialMode: 'chat', initialModel: runtime.modelSelection.getSelection(), getContextWindow: () => runtime.contextSelection.getContextWindow() });
  const controller = createChatController({
    host: runtime.host, model: runtime.model, initialMode: 'chat',
    getConversationId: () => persistence.ensureConversation(),
    getContextWindow: () => runtime.contextSelection.getContextWindow(),
    getModelKey: () => {
      const selected = runtime.modelSelection.getSelection();
      return contextAccountingModelKey(selected.providerId, selected.modelId);
    },
  });
  const project = createAcpUpdateProjector();
  let queue = Promise.resolve();
  let failure: unknown;
  const unsubscribe = controller.subscribe((snapshot) => {
    persistence.syncSnapshot(snapshot);
    for (const event of project(snapshot)) {
      queue = queue.then(() => update(event)).catch((error) => { failure = error; controller.cancel(); });
    }
  });
  let turnSignal: AbortSignal | undefined;
  const lifetime = new AbortController();
  const unsubscribeApproval = runtime.host.subscribeApproval((approval) => {
    if (!approval) return;
    if (!approval.toolCallId || !turnSignal || turnSignal.aborted) { approval.resolve('deny'); return; }
    const signal = AbortSignal.any([turnSignal, lifetime.signal]);
    void requestAcpApproval(async () => {
      await queue;
      if (failure || signal.aborted) throw new Error('Permission request cancelled');
      return requestPermission({
        sessionId,
        toolCall: { toolCallId: approval.toolCallId!, title: approval.prompt.toolName, status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
        ],
      });
    }, signal).then((decision) => approval.resolve(decision));
  });
  return {
    ...createAcpModelConfig(runtime.modelSelection, () => persistence.syncModel(runtime.modelSelection.getSelection()), runtime.modelConfig.sharedProviders, runtime.languageStore.getLocale() === 'zh-CN', runtime.contextSelection),
    async prompt(text, signal) {
      if (signal.aborted) return;
      turnSignal = signal;
      const cancel = () => controller.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await controller.send(text);
        await queue;
        if (failure || controller.getSnapshot().error) throw new Error('Peer turn failed');
      } finally { turnSignal = undefined; signal.removeEventListener('abort', cancel); }
    },
    async dispose() {
      lifetime.abort();
      controller.cancel();
      unsubscribeApproval();
      unsubscribe();
      await runtime.host.dispose();
    },
  };
};
}
