import type {
  CapabilityManifest,
  CapabilityProvider,
  RuntimeToolResult,
} from '@peer-agent/runtime-core';
import type { RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';

import {
  asRecord,
  createNodePermissionGrant,
  createNodeToolResult,
  createProviderRuntimeClock,
  type NodeProviderRuntimeClock,
} from './provider-utils.ts';

/**
 * Local interaction capability — surfaces a user question and requests a turn stop.
 *
 * Chain: Capability Provider → Manifest → Runtime Projection → Tool Call →
 * PermissionGrant → Evidence. Side-effect free; self-grants permission.
 */

export const INTERACTION_CAPABILITY_ID = 'local.interaction.request_user_input' as const;
export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input' as const;

const INTERACTION_MODE_SCOPES = Object.freeze([
  'chat',
  'plan',
  'goal',
  'compact',
  'system',
  'explorer',
] as const);

export const NODE_INTERACTION_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.freeze([
  {
    capabilityId: INTERACTION_CAPABILITY_ID,
    displayName: 'Request user input',
    description:
      'Ask the user a question and stop the current turn to wait for their reply. '
      + 'Call this whenever you need a decision, clarification, approval, or a choice '
      + 'from the user (for example: "commit as 1, 2, or 3?"). Do NOT keep running other '
      + 'tools or make the choice on the user\'s behalf in the same turn — calling this '
      + 'tool ends your turn and returns control to the user. Put the actual question '
      + '(and any options) in the arguments so the user sees it.',
    riskLevel: 'L0_inert',
    modeScopes: INTERACTION_MODE_SCOPES,
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user. Required and must be non-empty.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of discrete choices the user can pick from (e.g. ["1", "2", "3"]).',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
]);

export interface NodeInteractionProviderOptions {
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly clock?: NodeProviderRuntimeClock;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function localeFromContext(context: { readonly locale?: unknown } | undefined): string {
  return typeof context?.locale === 'string' ? context.locale : 'en';
}

function buildToolCall(request: {
  readonly toolCall?: RuntimeSdkToolCall;
  readonly capabilityId?: string;
}): RuntimeSdkToolCall {
  if (request.toolCall) return request.toolCall as RuntimeSdkToolCall;
  return {
    toolCallId: `interaction-${Date.now()}`,
    capabilityId: request.capabilityId || INTERACTION_CAPABILITY_ID,
  };
}


function formatInteractionPreview(question: string, optionsList: string[], note: string): string {
  const lines: string[] = [question];
  if (optionsList.length > 0) {
    lines.push('Options:');
    optionsList.forEach((option, index) => {
      lines.push(`  ${index + 1}. ${option}`);
    });
    lines.push('Reply with a number or type your answer.');
  } else {
    lines.push('Type your answer in the input below.');
  }
  if (note) lines.push(note);
  return lines.join('\n');
}

export function createNodeInteractionProvider(
  options: NodeInteractionProviderOptions = {},
): CapabilityProvider {
  const clock = options.clock ?? createProviderRuntimeClock(options);

  return {
    providerId: 'runtime-node.interaction',
    capabilities: NODE_INTERACTION_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const call = (request.toolCall as RuntimeSdkToolCall | undefined)
        ?? buildToolCall(request);
      const input = asRecord(request.input ?? request.toolCall?.input);
      const question = asString(input.question);
      const optionsList = asStringList(input.options);
      const locale = localeFromContext(context as { readonly locale?: unknown } | undefined);
      const grant = createNodePermissionGrant({
        clock,
        call,
        decision: 'allow',
        reason: 'interaction_self_grant',
      });

      if (!question) {
        const summary = locale.startsWith('zh')
          ? 'request_user_input 需要非空 question'
          : 'request_user_input requires a non-empty question';
        return {
          ...createNodeToolResult({
            clock,
            call,
            status: 'failed',
            summary,
            output: {
              ok: false,
              acknowledged: false,
              error: 'question_required',
              control: null,
            },
            outputPreview: summary,
            grant,
            error: { message: summary, code: 'question_required' },
            dataLevel: 'D0_public',
            metadata: {
              toolName: REQUEST_USER_INPUT_TOOL_NAME,
            },
          }),
          control: null,
        } as RuntimeToolResult;
      }

      const note = locale.startsWith('zh')
        ? '已向用户提出问题，本回合在此停止，等待用户输入后再继续。'
        : 'Question surfaced to the user. The turn stops here and waits for the user to reply.';
      const summary = locale.startsWith('zh')
        ? `已向用户提问：${question}`
        : `Asked the user: ${question}`;
      const control = {
        terminal: true,
        reason: 'request_user_input',
      } as const;
      const output = {
        ok: true,
        acknowledged: true,
        question,
        options: optionsList,
        note,
        control,
      };
      const preview = formatInteractionPreview(question, optionsList, note);

      return {
        ...createNodeToolResult({
          clock,
          call,
          status: 'completed',
          summary,
          output,
          outputPreview: preview,
          grant,
          dataLevel: 'D0_public',
          metadata: {
            toolName: REQUEST_USER_INPUT_TOOL_NAME,
            control,
            question,
            options: optionsList,
          },
        }),
        // Explicit control signal for agent loops / pipeline terminal mapping.
        control,
      } as RuntimeToolResult;
    },
  };
}
