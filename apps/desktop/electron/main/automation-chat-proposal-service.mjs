import { createHash, randomUUID } from 'node:crypto';

const TERMINAL_STATUSES = new Set(['created', 'cancelled']);

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function automationProposalFingerprint(definition) {
  const canonical = JSON.stringify(stableValue(definition));
  return createHash('sha256').update(canonical).digest('hex');
}

export function createAutomationCreateContext({
  source = 'chat_intent',
  now = new Date().toISOString(),
} = {}) {
  if (source !== 'automation_center' && source !== 'chat_intent') {
    throw new TypeError('source must be automation_center or chat_intent');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'automation_create',
    source,
    status: 'collecting',
    activeProposal: null,
    lastSettledProposal: null,
    rejectedFingerprints: [],
    createdAt: now,
    updatedAt: now,
  });
}

function assertCreateInput(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('definition is required');
  requiredString(definition.name, 'definition.name');
  requiredString(definition.prompt, 'definition.prompt');
  requiredString(definition.workspacePath, 'definition.workspacePath');
  if (!definition.schedule || typeof definition.schedule !== 'object') throw new TypeError('definition.schedule is required');
  requiredString(definition.schedule.timezone, 'definition.schedule.timezone');
  if (!definition.grant || typeof definition.grant !== 'object') throw new TypeError('definition.grant is required');
  if (!definition.notifications || typeof definition.notifications !== 'object') throw new TypeError('definition.notifications is required');
  if (!definition.budget || typeof definition.budget !== 'object') throw new TypeError('definition.budget is required');
  if (definition.enable !== true && definition.enable !== false) throw new TypeError('definition.enable is required');
  return structuredClone(definition);
}

function validateActionRequest(request) {
  const conversationId = requiredString(request?.conversationId, 'conversationId');
  const proposalId = requiredString(request?.proposalId, 'proposalId');
  const fingerprint = requiredString(request?.fingerprint, 'fingerprint');
  const action = request?.action;
  if (action !== 'confirm' && action !== 'cancel') throw new TypeError('action must be confirm or cancel');
  return { conversationId, proposalId, fingerprint, action };
}

function receiptFromDefinition(proposal, definition) {
  return Object.freeze({
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    fingerprint: proposal.fingerprint,
    conversationId: proposal.conversationId,
    automationId: requiredString(definition?.automationId, 'automation.automationId'),
    automationName: requiredString(definition?.name, 'automation.name'),
    definitionVersion: Number(definition?.version),
    lifecycleStatus: definition?.status,
    createdAt: requiredString(definition?.createdAt, 'automation.createdAt'),
    nextRunAt: null,
  });
}

export function createAutomationChatProposalService({
  getContext,
  saveContext,
  createAutomation,
  now = () => new Date().toISOString(),
  createId = randomUUID,
} = {}) {
  if (typeof getContext !== 'function') throw new TypeError('getContext is required');
  if (typeof saveContext !== 'function') throw new TypeError('saveContext is required');
  if (typeof createAutomation !== 'function') throw new TypeError('createAutomation is required');

  function contextFor(conversationId, source) {
    return getContext(conversationId) ?? createAutomationCreateContext({ source, now: now() });
  }

  function propose({ conversationId, definition, source = 'chat_intent', confidence = 'high' } = {}) {
    const id = requiredString(conversationId, 'conversationId');
    const input = assertCreateInput(definition);
    if (confidence !== 'high' && confidence !== 'medium') throw new TypeError('confidence must be high or medium');
    const fingerprint = automationProposalFingerprint(input);
    const current = contextFor(id, source);
    if (current.rejectedFingerprints?.includes(fingerprint)) {
      return Object.freeze({ suppressed: true, reason: 'rejected_fingerprint', proposal: null });
    }
    const active = current.activeProposal;
    if (active?.fingerprint === fingerprint && !TERMINAL_STATUSES.has(active.status)) {
      return Object.freeze({ suppressed: false, replayed: true, proposal: active });
    }
    const timestamp = now();
    const proposal = Object.freeze({
      schemaVersion: 1,
      proposalId: createId(),
      conversationId: id,
      fingerprint,
      source,
      confidence,
      status: 'proposed',
      definition: input,
      replacesProposalId: active?.proposalId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      automationId: null,
      receipt: null,
      error: null,
    });
    saveContext(id, Object.freeze({
      ...current,
      source,
      status: 'proposed',
      activeProposal: proposal,
      updatedAt: timestamp,
    }));
    return Object.freeze({ suppressed: false, replayed: false, proposal });
  }

  async function act(request) {
    const { conversationId, proposalId, fingerprint, action } = validateActionRequest(request);
    const current = getContext(conversationId);
    const activeProposal = current?.activeProposal;
    const settledProposal = current?.lastSettledProposal;
    const proposal = activeProposal
      ?? (settledProposal?.proposalId === proposalId && settledProposal.fingerprint === fingerprint
        ? settledProposal
        : null);
    if (!proposal) throw new Error('automation_proposal_not_found');
    if (proposal.proposalId !== proposalId || proposal.fingerprint !== fingerprint) {
      throw new Error('automation_proposal_stale');
    }

    if (action === 'cancel') {
      if (proposal.status === 'cancelled') return Object.freeze({ proposal, receipt: null, replayed: true });
      if (proposal.status === 'created' || proposal.status === 'creating') throw new Error('automation_proposal_not_cancellable');
      const timestamp = now();
      const cancelled = Object.freeze({ ...proposal, status: 'cancelled', updatedAt: timestamp });
      const rejectedFingerprints = [...new Set([...(current.rejectedFingerprints ?? []), fingerprint])];
      saveContext(conversationId, Object.freeze({
        ...current,
        status: 'cancelled',
        activeProposal: null,
        lastSettledProposal: cancelled,
        rejectedFingerprints,
        updatedAt: timestamp,
      }));
      return Object.freeze({ proposal: cancelled, receipt: null, replayed: false });
    }

    if (proposal.status === 'created' && proposal.receipt) {
      return Object.freeze({ proposal, receipt: proposal.receipt, replayed: true });
    }
    if (proposal.status === 'creating') throw new Error('automation_proposal_creating');
    if (proposal.status !== 'proposed' && proposal.status !== 'failed') {
      throw new Error('automation_proposal_not_confirmable');
    }

    const creatingAt = now();
    const creating = Object.freeze({ ...proposal, status: 'creating', updatedAt: creatingAt, error: null });
    saveContext(conversationId, Object.freeze({
      ...current,
      status: 'creating',
      activeProposal: creating,
      updatedAt: creatingAt,
    }));

    try {
      const definition = await createAutomation(structuredClone(proposal.definition));
      const receipt = receiptFromDefinition(proposal, definition);
      const createdAt = now();
      const created = Object.freeze({
        ...creating,
        status: 'created',
        automationId: receipt.automationId,
        receipt,
        updatedAt: createdAt,
      });
      saveContext(conversationId, Object.freeze({
        ...current,
        status: 'created',
        activeProposal: null,
        lastSettledProposal: created,
        updatedAt: createdAt,
      }));
      return Object.freeze({ proposal: created, receipt, replayed: false });
    } catch (error) {
      const failedAt = now();
      const failed = Object.freeze({
        ...creating,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: failedAt,
      });
      saveContext(conversationId, Object.freeze({
        ...current,
        status: 'failed',
        activeProposal: failed,
        updatedAt: failedAt,
      }));
      throw error;
    }
  }

  return Object.freeze({ propose, act });
}
