import { interactiveDigest, interactiveToken } from '@peer-agent/protocol';
import { problem } from './storage.mjs';

export function cleanupRequest(raw) {
  const { requestId, expectedDigest } = raw ?? {};
  if (!interactiveToken(requestId) || !interactiveDigest(expectedDigest)) throw problem('interactive_cleanup_invalid');
  return { requestId, expectedDigest };
}

export function matchCleanupReceipt(receipt, { requestId, expectedDigest }) {
  if (receipt && (receipt.requestId !== requestId || receipt.expectedDigest !== expectedDigest))
    throw problem('interactive_cleanup_parameter_conflict');
  return receipt;
}

/** Separate a transaction failure from a lost confirmation after the transaction returned. */
export function withCleanupOutcome(storage, workspaceId, work) {
  let committed = false;
  const commit = mutate => {
    const receipt = storage.transaction(workspaceId, mutate);
    committed = true;
    return receipt;
  };
  try {
    return work(commit);
  } catch (cause) {
    if (!committed) throw cause;
    const code = 'interactive_cleanup_outcome_unknown';
    throw Object.assign(new Error(code, { cause }), { code });
  }
}
