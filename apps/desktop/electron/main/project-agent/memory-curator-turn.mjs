/**
 * 桌面临时整理回合。CollectingSink 不把过程写进对话。
 * 模式 memory_curator 不投影现有工具；省档模型来自已保存的路由。
 */
import { randomUUID } from 'node:crypto';

import { resolveStoredModelRouting } from '@peer-agent/runtime-node';

import { createCollectingSink } from '../agent-host/turn-sinks.mjs';

export function curatorModelProviderId(settings) {
  const routing = resolveStoredModelRouting(settings?.modelRouting, []);
  const role = routing.roles?.memory_curator;
  if (role?.mode === 'fixed' && typeof role.modelProviderId === 'string' && role.modelProviderId) {
    return role.modelProviderId;
  }
  const tier = role?.mode === 'tier' ? role.tier : 'economy';
  const primary = routing.tiers?.[tier]?.primary;
  return typeof primary === 'string' && primary ? primary : null;
}

export async function runMemoryCuratorTurn({
  request,
  runTurn,
  getSettings,
  resolveRoute = null,
  createSink = createCollectingSink,
} = {}) {
  if (typeof runTurn !== 'function') return { text: '' };
  let modelProviderId = null;
  if (typeof resolveRoute === 'function') {
    let route = null;
    try {
      route = resolveRoute({ role: 'memory_curator', workspaceId: request?.workspaceId });
    } catch {
      route = null;
    }
    if (route && route.ok === false) return { text: '', skipped: route.reason || 'route_blocked' };
    const selected = route?.selection?.modelProviderId;
    if (typeof selected === 'string' && selected) modelProviderId = selected;
  }
  if (!modelProviderId) {
    modelProviderId = curatorModelProviderId(typeof getSettings === 'function' ? getSettings() : null);
  }
  const sink = createSink();
  await runTurn({
    turnProfile: {
      role: 'memory_curator',
      ...(typeof request?.workspaceId === 'string' && request.workspaceId
        ? { workspaceId: request.workspaceId }
        : {}),
      excludeCapabilityPrefixes: Array.isArray(request?.excludeCapabilityPrefixes)
        ? request.excludeCapabilityPrefixes
        : [],
      ...(modelProviderId ? { modelSelection: { modelProviderId, source: 'routing' } } : {}),
    },
    sink,
    messages: Array.isArray(request?.messages) ? request.messages : [],
    mode: 'memory_curator',
    conversationId: null,
    ephemeral: true,
    modelProviderId,
    streamId: randomUUID(),
  });
  const text = typeof sink.getText === 'function' ? sink.getText() : '';
  return { text: typeof text === 'string' ? text : '' };
}
