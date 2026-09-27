/**
 * 记忆能力。检索只读；记住和忘掉只改记忆本身。
 * 模型不能指定 trust。stated 必须锚到 user_input；verified 只走 writeVerified。
 */
import path from 'node:path';

import { createEvidenceBundle } from '@peer-agent/runtime-core';

import { pathOf } from '../data-store.mjs';
import { isProjectAgentTurn } from '../project-agent/mode-policy.mjs';
import {
  MEMORY_CAPABILITY_IDS,
  memorySpecByCapability,
  validateMemoryInput,
} from '../project-agent/tool-specs.mjs';
import { createPermissionGrant } from '../tool-result-factory.mjs';
import { createMemoryIndex } from './memory-index.mjs';
import { createMemoryStore } from './memory-store.mjs';

const MESSAGES = {
  sensitive: ['这条内容里有密钥或令牌，没有写入。', 'Secret-like content was refused. Nothing was written.'],
  anchor_required: ['没有指向用户消息的锚点，没有写入。', 'An anchor to a user message is required. Nothing was written.'],
  anchor_not_user_input: ['锚点不是用户输入，没有写入。', 'The anchor is not a user_input message. Nothing was written.'],
  source_refs_required: ['已验证记忆必须带来源。', 'Verified memory requires source refs.'],
  invalid_workspace: ['工作区标识无效。', 'The workspace id is invalid.'],
  invalid_kind: ['记忆类型无效。', 'The memory kind is invalid.'],
  not_found: ['没有这条记忆。', 'Memory was not found.'],
  not_project_agent: ['只有项目代理可以读写记忆。', 'Only the project agent can read or write memory.'],
  memory_disabled: ['记忆已关闭，没有写入，也没有读取。', 'Memory is off. Nothing was written or read.'],
  invalid_input: ['记忆参数无效。', 'Memory input is invalid.'],
};

function resolveIndexFile(options) {
  if (typeof options.indexFile === 'string' && options.indexFile) return options.indexFile;
  if (options.rootDir) return path.join(options.rootDir, 'cache', 'memory-index', 'memory-index.sqlite');
  return path.join(pathOf('memoryIndex'), 'memory-index.sqlite');
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseArgs(call) {
  const raw = call?.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function publicItem(item) {
  return {
    id: item.id,
    scope: item.scope,
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    kind: item.kind,
    text: item.text,
    trust: item.trust,
    sourceRefs: [...item.sourceRefs],
    pinned: item.pinned === true,
    status: item.status,
  };
}

export function createMemoryProvider(options = {}) {
  let opened = null;

  function resources() {
    if (opened) return opened;
    const store = options.store || createMemoryStore(options);
    const index = createMemoryIndex({ file: resolveIndexFile(options) });
    index.rebuild(store.list({ status: 'active' }));
    opened = { store, index };
    return opened;
  }

  function rebuildIndex() {
    const { store, index } = resources();
    index.rebuild(store.list({ status: 'active' }));
  }

  function searchable(workspaceId, scope) {
    const { store } = resources();
    if (scope === 'user' || !workspaceId) {
      return store.list({ status: 'active', scope: 'user' });
    }
    const items = store.list({
      status: 'active',
      ...(scope === 'project' ? { scope: 'project' } : {}),
      workspaceId,
    });
    return items.filter((item) => {
      if (item.scope === 'user') return scope !== 'project';
      return item.workspaceId === workspaceId;
    });
  }

  async function executeCapability(request, context = {}) {
    const call = request?.call ?? {};
    const capabilityId = call.capabilityId;
    const item = memorySpecByCapability(capabilityId);
    const locale = context.locale === 'en-US' ? 'en-US' : 'zh-CN';
    if (!item) {
      return finish({
        call,
        capabilityId: capabilityId || 'local.memory',
        name: 'memory',
        locale,
        status: 'failed',
        output: { ok: false, error: 'invalid_input', message: explain('invalid_input', locale) },
      });
    }
    if (!isProjectAgentTurn({
      mode: context.mode ?? request?.mode,
      role: context.role ?? context.turnProfile?.role ?? request?.turnProfile?.role,
    })) {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'failed',
        output: { ok: false, error: 'not_project_agent', message: explain('not_project_agent', locale) },
      });
    }
    const workspaceId = text(context?.workspaceId);
    if (typeof options.enabled === 'function' && options.enabled(workspaceId) === false) {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'failed',
        output: { ok: false, error: 'memory_disabled', message: explain('memory_disabled', locale) },
      });
    }
    const validated = validateMemoryInput(item.name, parseArgs(call));
    if (!validated.ok) {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'failed',
        output: { ok: false, error: validated.error, message: validated.message },
      });
    }
    try {
      const output = item.name === 'memory_search'
        ? search(validated.value, context)
        : item.name === 'memory_remember'
          ? remember(validated.value, context)
          : forget(validated.value, context);
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: output.ok ? 'success' : 'failed',
        output: output.ok ? output : { ...output, message: output.message || explain(output.error, locale) },
      });
    } catch {
      return finish({
        call,
        capabilityId,
        name: item.name,
        locale,
        status: 'failed',
        output: { ok: false, error: 'memory_failed', message: explain('invalid_input', locale) },
      });
    }
  }

  function search(input, context) {
    const workspaceId = text(context?.workspaceId);
    if (input.scope === 'project' && !workspaceId) {
      return { ok: false, error: 'invalid_workspace' };
    }
    const { index } = resources();
    const limit = input.limit || 8;
    const hits = index.search(input.query, { limit: 200 });
    const byId = new Map(searchable(workspaceId, input.scope).map((item) => [item.id, item]));
    const items = [];
    for (const hit of hits) {
      const found = byId.get(hit.id);
      if (!found) continue;
      items.push(publicItem(found));
      if (items.length >= limit) break;
    }
    if (items.length) {
      resources().store.markUsed?.(items.map((item) => item.id));
    }
    return { ok: true, items };
  }

  function remember(input, context) {
    const { store, index } = resources();
    const saved = store.rememberStated({
      ...input,
      workspaceId: text(context?.workspaceId),
      messages: context?.messages,
    });
    if (!saved.ok) return { ok: false, error: saved.reason };
    index.upsert(saved.item);
    return { ok: true, id: saved.item.id, trust: saved.item.trust, status: saved.item.status };
  }

  function forget(input, context) {
    const { store, index } = resources();
    const saved = store.forget({
      ...input,
      workspaceId: text(context?.workspaceId),
    });
    if (!saved.ok) return { ok: false, error: saved.reason };
    index.remove(saved.item.id);
    return { ok: true, id: saved.item.id, status: 'forgotten' };
  }

  return {
    providerId: 'local.memory',
    capabilityIds: [...MEMORY_CAPABILITY_IDS],
    executeCapability,
    rebuildIndex,
    close() {
      opened?.index.close();
      opened = null;
    },
  };
}

function explain(reason, locale) {
  const pair = MESSAGES[reason];
  if (!pair) return reason;
  return locale === 'en-US' ? pair[1] : pair[0];
}

function finish({ call, capabilityId, name, locale, status, output }) {
  const granted = status === 'success';
  const outputText = JSON.stringify(output);
  const detail = output.error || output.id || status;
  return {
    call,
    grant: {
      ...createPermissionGrant({
        toolCallId: call.toolCallId,
        granted,
        scope: capabilityId,
        duration: granted ? 'once' : 'denied',
      }),
      reason: 'project_agent_memory',
    },
    result: {
      toolCallId: call.toolCallId,
      status,
      outputPreview: {
        status,
        tool: name,
        legacyResult: { success: granted, output: outputText },
      },
      evidence: createEvidenceBundle({
        evidenceId: `memory-${call.toolCallId || name}`,
        toolCallId: call.toolCallId,
        summary: locale === 'zh-CN'
          ? `记忆 ${name}：${detail}。`
          : `Memory ${name}: ${detail}.`,
        locale,
        returnedToCloud: false,
        dataLevel: 'D1_internal',
      }),
    },
  };
}
