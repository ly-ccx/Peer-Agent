import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import type { TuiHost } from './tui-host.ts';

const INTERACTIVE_CAPABILITY_ID = 'local.interaction.request_user_input';

function deniedExecution(
  capabilityId: string,
  message: string,
): RuntimeSdkProviderExecution {
  return {
    result: {
      toolCallId: `exec-denied-${capabilityId}`,
      capabilityId,
      status: 'failed',
      summary: message,
      error: { message },
      output: { ok: false, error: message },
      outputPreview: message,
      evidence: {
        summary: message,
        returnedToCloud: true,
        dataLevel: 'D1_internal',
      },
    },
  } as RuntimeSdkProviderExecution;
}

function filterTools(
  tools: readonly RuntimeToolDefinition[],
  allow: ReadonlySet<string>,
): readonly RuntimeToolDefinition[] {
  return tools.filter((tool) => allow.has(tool.capabilityId));
}

export function restrictTuiHostTools(
  host: TuiHost,
  capabilityIds: readonly string[],
): TuiHost {
  const allow = new Set(capabilityIds);
  const apply = (tools: readonly RuntimeToolDefinition[]) => filterTools(tools, allow);
  return {
    ...host,
    capabilities: apply(host.toolDefinitions).map((tool) => tool.capabilityId),
    toolDefinitions: apply(host.toolDefinitions),
    capabilitiesForMode: host.capabilitiesForMode
      ? (mode) => apply(host.toolDefinitionsForMode?.(mode) ?? host.toolDefinitions)
        .map((tool) => tool.capabilityId)
      : undefined,
    toolDefinitionsForMode: host.toolDefinitionsForMode
      ? (mode) => apply(host.toolDefinitionsForMode?.(mode) ?? host.toolDefinitions)
      : undefined,
    async execute(capabilityId, arguments_, context) {
      if (!allow.has(capabilityId)) {
        return deniedExecution(capabilityId, `Tool ${capabilityId} is outside --tools`);
      }
      return host.execute(capabilityId, arguments_, context);
    },
  };
}

export function denyInteractiveTools(host: TuiHost): TuiHost {
  return {
    ...host,
    async execute(capabilityId, arguments_, context) {
      if (capabilityId === INTERACTIVE_CAPABILITY_ID) {
        return deniedExecution(
          capabilityId,
          'request_user_input is unavailable without a TTY',
        );
      }
      return host.execute(capabilityId, arguments_, context);
    },
  };
}
