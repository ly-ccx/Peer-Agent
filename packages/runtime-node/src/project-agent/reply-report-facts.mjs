import { createHash } from 'node:crypto';

const key = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Only validated host states and observation Evidence identify a report; prose never does. */
export function prepareReplyReport({ workspaceId, message, currentInputAnchors = [], reportedMessages = [], toolCalls = [] }) {
  const keys = factKeys(workspaceId, message);
  if (!keys.length) return { suppressed: false, keys };
  const seen = new Set();
  if (!currentInputAnchors.length) {
    for (const reply of reportedMessages) {
      if (reply?.kind !== 'agent_reply') continue;
      for (const id of storedKeys(workspaceId, reply)) seen.add(id);
    }
  }
  for (const call of toolCalls) {
    if (call?.name !== 'post_reply') continue;
    const receipt = successfulReceipt(call.result);
    if (!receipt?.message || receipt.message.kind !== 'agent_reply') continue;
    for (const id of storedKeys(workspaceId, receipt.message)) seen.add(id);
  }
  return { keys, suppressed: keys.every(id => seen.has(id)) };
}

function factKeys(workspaceId, message) {
  if (typeof workspaceId !== 'string' || !workspaceId) return [];
  const keys = (message?.meta?.sessionStates || []).flatMap(state => {
    if (!message.sources?.includes(state.sessionId)) return [];
    const mark = message.marks?.find(item => item.sessionId === state.sessionId);
    return [key([workspaceId, 'session', state.sessionId, state.status, mark?.outcome || '', mark?.verdictRef || ''])];
  });
  for (const ref of message?.meta?.evidenceRefs || []) {
    if (typeof ref === 'string' && ref.startsWith('objective-probe:')) keys.push(key([workspaceId, 'observation', ref]));
  }
  return [...new Set(keys)];
}

function storedKeys(workspaceId, message) {
  const recorded = message.meta?.reportFactKeys;
  return Array.isArray(recorded) ? recorded.filter(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
    : factKeys(workspaceId, message);
}

function successfulReceipt(result) {
  if (typeof result === 'string') {
    try { return successfulReceipt(JSON.parse(result)); } catch { return null; }
  }
  if (!result || typeof result !== 'object' || result.ok === false || result.success === false || result.error
    || ['failed', 'denied', 'cancelled'].includes(result.status)) return null;
  const nested = result.output ?? result.outputPreview?.legacyResult ?? result.legacyResult;
  if (nested != null) return successfulReceipt(nested);
  return result.message?.kind === 'agent_reply' ? result : null;
}
