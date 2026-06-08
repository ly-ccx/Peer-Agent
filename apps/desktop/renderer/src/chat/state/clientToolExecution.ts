import type {
  AuthState,
  ClientToolCall,
  ClientToolResult,
  PermissionGrant,
} from '@zeus-atlas/protocol';
import { clientApi } from '../../clientApi';
import { createUnsupportedClientToolResult } from './clientToolCallEvents';
import {
  createDeniedClientToolResult,
  createFailedClientToolResult,
} from './clientToolEvidence.ts';
import { errorMessage, localeFromAuthState } from './runtimeHelpers';

interface ClientToolResolution {
  readonly grant: PermissionGrant;
  readonly result: ClientToolResult;
}

export async function runApprovedClientToolCall(
  call: ClientToolCall,
  authState: AuthState | null,
): Promise<ClientToolResolution> {
  const locale = localeFromAuthState(authState);
  const grant = await clientApi.approveLocalAction(call.toolCallId);
  try {
    if (call.capabilityId === 'local.health') {
      const result = await clientApi.runHealthCheck(call.toolCallId);
      return { grant, result };
    }
    if (
      call.capabilityId === 'local.shell.exec' ||
      call.capabilityId === 'local.shell.stop' ||
      call.capabilityId.startsWith('local.skill.')
    ) {
      const execution = await clientApi.executeClientToolCall(call, grant);
      return {
        grant: execution.grant ?? grant,
        result: execution.result,
      };
    }
    return { grant, result: createUnsupportedClientToolResult(call, locale) };
  } catch (nextError) {
    return {
      grant,
      result: createFailedClientToolResult({
        call,
        locale,
        message: errorMessage(nextError, 'local capability execution failed'),
      }),
    };
  }
}

export async function denyClientToolCall(
  call: ClientToolCall,
  authState: AuthState | null,
): Promise<ClientToolResolution> {
  const locale = localeFromAuthState(authState);
  return {
    grant: await clientApi.denyLocalAction(call.toolCallId),
    result: createDeniedClientToolResult({ call, locale }),
  };
}
