/**
 * 调度工具的名字、capabilityId 和输入约束。桌面与 TUI 共用这一份。
 * 开任务和写回复的执行不在这里，只做能在调用前判定的输入校验。
 */
export const DELEGATION_TOOL_SPECS = Object.freeze([
  spec('spawn_session', 'local.delegation.spawn_session', {
    type: 'object',
    properties: {
      anchorMessageIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
        description: 'Ids of user_input messages in this conversation. At least one.',
      },
      title: { type: 'string', maxLength: 60 },
      brief: { type: 'string', maxLength: 4000 },
      successCriteria: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: { type: 'string' },
      },
      kind: { type: 'string', enum: ['code', 'research', 'docs', 'ui', 'ops', 'other'] },
      readOnly: { type: 'boolean' },
      modelPreference: {
        type: 'object',
        properties: {
          modelProviderId: { type: 'string' },
          reason: { type: 'string' },
        },
        additionalProperties: false,
      },
      priority: { type: 'string' },
      dependsOn: { type: 'array', items: { type: 'string' } },
      isolation: { type: 'string' },
    },
    required: ['anchorMessageIds', 'title', 'brief', 'successCriteria', 'kind', 'readOnly'],
    additionalProperties: false,
  }),
  spec('list_sessions', 'local.delegation.list_sessions', {
    type: 'object',
    properties: {
      status: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  }),
  spec('get_session', 'local.delegation.get_session', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      detail: { type: 'string', enum: ['summary', 'report'] },
    },
    required: ['sessionId'],
    additionalProperties: false,
  }),
  spec('cancel_session', 'local.delegation.cancel_session', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['sessionId', 'reason'],
    additionalProperties: false,
  }),
  spec('message_session', 'local.delegation.message_session', {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      text: { type: 'string' },
      intent: { type: 'string', enum: ['answer'] },
    },
    required: ['sessionId', 'text', 'intent'],
    additionalProperties: false,
  }),
  spec('post_reply', 'local.delegation.post_reply', {
    type: 'object',
    properties: {
      replyTo: { type: 'array', items: { type: 'string' } },
      text: { type: 'string', maxLength: 2000 },
      proactive: { type: 'boolean' },
      sources: { type: 'array', items: { type: 'string' } },
      question: {
        type: 'object',
        properties: {
          options: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['options'],
        additionalProperties: false,
      },
    },
    required: ['text'],
    additionalProperties: false,
  }),
]);

export const DELEGATION_CAPABILITY_IDS = Object.freeze(
  DELEGATION_TOOL_SPECS.map((item) => item.capabilityId),
);

const SPECS_BY_NAME = new Map(DELEGATION_TOOL_SPECS.map((item) => [item.name, item]));
const SPECS_BY_CAPABILITY = new Map(DELEGATION_TOOL_SPECS.map((item) => [item.capabilityId, item]));

export function delegationSpecByCapability(capabilityId) {
  return SPECS_BY_CAPABILITY.get(capabilityId) ?? null;
}

export function validateDelegationInput(name, raw) {
  const item = SPECS_BY_NAME.get(name);
  if (!item) return invalid(`Unknown delegation tool: ${name}`);
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (name === 'spawn_session') return validateSpawn(input);
  if (name === 'list_sessions') return validateList(input);
  if (name === 'get_session') return validateGet(input);
  if (name === 'cancel_session') return validateCancel(input);
  if (name === 'message_session') return validateMessage(input);
  return validateReply(input);
}

function spec(name, capabilityId, inputSchema) {
  return Object.freeze({ name, capabilityId, inputSchema });
}

function invalid(message) {
  return { ok: false, error: 'invalid_input', message };
}

function text(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function stringList(value, { min = 0, max = 50, itemMax = 200 } = {}) {
  if (!Array.isArray(value)) return null;
  if (value.length < min || value.length > max) return null;
  const items = [];
  for (const item of value) {
    const next = text(item, itemMax);
    if (!next) return null;
    items.push(next);
  }
  return items;
}

function validateSpawn(input) {
  const anchorMessageIds = stringList(input.anchorMessageIds, { min: 1, max: 8, itemMax: 200 });
  const title = text(input.title, 60);
  const brief = text(input.brief, 4000);
  const successCriteria = stringList(input.successCriteria, { min: 1, max: 8, itemMax: 500 });
  const kinds = new Set(['code', 'research', 'docs', 'ui', 'ops', 'other']);
  if (!anchorMessageIds) return invalid('anchorMessageIds must contain 1 to 8 message ids.');
  if (!title) return invalid('title is required and must be at most 60 characters.');
  if (!brief) return invalid('brief is required and must be at most 4000 characters.');
  if (!successCriteria) return invalid('successCriteria must contain 1 to 8 items.');
  if (!kinds.has(input.kind)) return invalid('kind must be code, research, docs, ui, ops, or other.');
  if (typeof input.readOnly !== 'boolean') return invalid('readOnly must be a boolean.');
  const value = {
    anchorMessageIds,
    title,
    brief,
    successCriteria,
    kind: input.kind,
    readOnly: input.readOnly,
  };
  if (input.modelPreference !== undefined) {
    const preference = input.modelPreference;
    if (!preference || typeof preference !== 'object' || Array.isArray(preference)) {
      return invalid('modelPreference must be an object.');
    }
    const reason = text(preference.reason, 500);
    if (!reason) return invalid('modelPreference.reason is required.');
    const modelProviderId = preference.modelProviderId === undefined
      ? null
      : text(preference.modelProviderId, 200);
    if (preference.modelProviderId !== undefined && !modelProviderId) {
      return invalid('modelPreference.modelProviderId must be a non-empty string.');
    }
    value.modelPreference = {
      ...(modelProviderId ? { modelProviderId } : {}),
      reason,
    };
  }
  if (input.priority !== undefined) {
    const priority = text(input.priority, 40);
    if (!priority) return invalid('priority must be a short string.');
    value.priority = priority;
  }
  if (input.dependsOn !== undefined) {
    const dependsOn = stringList(input.dependsOn, { max: 8, itemMax: 200 });
    if (!dependsOn) return invalid('dependsOn must be a list of session ids.');
    value.dependsOn = dependsOn;
  }
  if (input.isolation !== undefined) {
    const isolation = text(input.isolation, 40);
    if (!isolation) return invalid('isolation must be a short string.');
    value.isolation = isolation;
  }
  return { ok: true, value };
}

function validateList(input) {
  const value = {};
  if (input.status !== undefined) {
    const status = text(input.status, 40);
    if (!status) return invalid('status must be a short string.');
    value.status = status;
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      return invalid('limit must be an integer from 1 to 50.');
    }
    value.limit = input.limit;
  }
  return { ok: true, value };
}

function validateGet(input) {
  const sessionId = text(input.sessionId, 200);
  if (!sessionId) return invalid('sessionId is required.');
  const detail = input.detail === undefined ? 'summary' : input.detail;
  if (detail !== 'summary' && detail !== 'report') {
    return invalid('detail must be summary or report.');
  }
  return { ok: true, value: { sessionId, detail } };
}

function validateCancel(input) {
  const sessionId = text(input.sessionId, 200);
  const reason = text(input.reason, 500);
  if (!sessionId) return invalid('sessionId is required.');
  if (!reason) return invalid('reason is required.');
  return { ok: true, value: { sessionId, reason } };
}

function validateMessage(input) {
  const sessionId = text(input.sessionId, 200);
  const body = text(input.text, 4000);
  if (!sessionId) return invalid('sessionId is required.');
  if (!body) return invalid('text is required and must be at most 4000 characters.');
  if (input.intent !== 'answer') {
    return {
      ok: false,
      error: 'unsupported_intent',
      message: 'message_session currently accepts only intent "answer".',
    };
  }
  return { ok: true, value: { sessionId, text: body, intent: 'answer' } };
}

function validateReply(input) {
  const body = text(input.text, 2000);
  if (!body) return invalid('text is required and must be at most 2000 characters.');
  const replyTo = input.replyTo === undefined
    ? []
    : stringList(input.replyTo, { max: 20, itemMax: 200 });
  if (!replyTo) return invalid('replyTo must be a list of message ids.');
  if (replyTo.length === 0 && input.proactive !== true) {
    return invalid('replyTo is required unless proactive is true.');
  }
  const value = {
    replyTo,
    text: body,
    ...(input.proactive === true ? { proactive: true } : {}),
  };
  if (input.sources !== undefined) {
    const sources = stringList(input.sources, { max: 20, itemMax: 200 });
    if (!sources) return invalid('sources must be a list of session ids.');
    value.sources = sources;
  }
  if (input.question !== undefined) {
    const options = stringList(input.question?.options, { min: 1, max: 8, itemMax: 200 });
    if (!options) return invalid('question.options must contain 1 to 8 choices.');
    value.question = { options };
  }
  return { ok: true, value };
}
