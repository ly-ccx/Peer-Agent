import { reduceChatRuntime } from '@zeus-atlas/chat-kernel';
import type {
  ChatRuntimeState,
  HumanConfirmationDecision,
  PendingHumanConfirmation,
} from '@zeus-atlas/protocol';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback } from 'react';
import { chatClient } from '../api/chatClient';
import { errorMessage } from './runtimeHelpers';

interface UseHumanConfirmationActionsParams {
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setState: Dispatch<SetStateAction<ChatRuntimeState>>;
}

export function useHumanConfirmationActions({
  setError,
  setState,
}: UseHumanConfirmationActionsParams) {
  return useCallback(async (
    confirmation: PendingHumanConfirmation,
    decision: HumanConfirmationDecision,
  ) => {
    setError(null);
    try {
      await chatClient.confirmExecution({
        executionUuid: confirmation.executionUuid,
        confirmationId: confirmation.confirmationId,
        decision,
      });
      setState((current) =>
        reduceChatRuntime(current, {
          type: 'confirmation_resolved',
          confirmation: {
            confirmationId: confirmation.confirmationId,
            executionUuid: confirmation.executionUuid,
            decision,
            resolvedAt: new Date().toISOString(),
            status: 'resolved',
          },
        }),
      );
    } catch (nextError) {
      setError(errorMessage(nextError, '确认操作失败'));
    }
  }, [setError, setState]);
}
