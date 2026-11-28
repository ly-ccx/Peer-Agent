import type { InputRecoveryView } from '@peer-agent/runtime-core';

/** Stable snapshots let each surface react only to the input facts it displays. */
export function createInputRecoveryProjection<Key extends keyof InputRecoveryView>(
  read: () => InputRecoveryView, keys: readonly Key[],
): () => Pick<InputRecoveryView, Key> {
  let previous: Pick<InputRecoveryView, Key> | undefined;
  return () => {
    const state = read();
    if (!previous || keys.some(key => !Object.is(previous![key], state[key]))) {
      previous = Object.fromEntries(keys.map(key => [key, state[key]])) as Pick<InputRecoveryView, Key>;
    }
    return previous;
  };
}

export const conversationInputKeys = ['ready', 'pending', 'received', 'sending', 'rejected', 'mutating'] as const;
export const composerInputKeys = ['ready', 'error', 'draft', 'pending', 'sending', 'rejected', 'mutating'] as const;
export const composerStatusKeys = ['ready', 'error', 'pending', 'sending', 'rejected', 'mutating'] as const;
export const composerDraftKeys = ['draft'] as const;
