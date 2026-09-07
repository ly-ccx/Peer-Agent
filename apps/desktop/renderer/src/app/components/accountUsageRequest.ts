import type { LlmSubscriptionQuota } from '@peer-agent/protocol';

/** Cancellation governs both successful and failed asynchronous observations. */
export async function observeAccountUsageRequest(
  request: () => Promise<LlmSubscriptionQuota>,
  active: () => boolean,
  success: (value: LlmSubscriptionQuota) => void,
  failure: () => void,
): Promise<void> {
  if (!active()) return;
  try {
    const value = await request();
    if (active()) success(value);
  } catch {
    if (active()) failure();
  }
}
