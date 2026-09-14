import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';

/** Only a valid, timely allow-once response may enter the local authorization host. */
export async function requestAcpApproval(
  request: () => Promise<RequestPermissionResponse>,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<'allow-once' | 'deny'> {
  if (signal.aborted) return 'deny';
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: 'allow-once' | 'deny') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve(signal.aborted ? 'deny' : decision);
    };
    const cancel = () => finish('deny');
    const timer = setTimeout(cancel, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => signal.aborted ? null : request()).then((response) => {
      finish(response?.outcome.outcome === 'selected' && response.outcome.optionId === 'allow-once' ? 'allow-once' : 'deny');
    }).catch(() => finish('deny'));
  });
}
