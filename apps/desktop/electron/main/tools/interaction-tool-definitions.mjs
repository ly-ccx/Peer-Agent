/**
 * Interaction 模式本地工具定义（Manifest）—— 见 docs/proposals/0003-request-user-input.md。
 *
 * 该工具经正规运行时链路暴露：
 *   Capability Provider(local.interaction.request_user_input) → Manifest(本文件)
 *     → Runtime Projection → Tool Call(request_user_input) → PermissionGrant → Evidence
 *
 * 用途：当 agent 需要向用户征求决定 / 澄清 / 选择（例如「按 1/2/3 哪种方式提交？」），
 * 不应在同一回合继续自行执行并替用户做选择。它应调用本工具把问题登记为 Evidence，
 * provider 在结果里附带「终止回合」的控制信号，agent loop 据此停止回灌、交还控制权，
 * 等待用户输入后再继续。
 *
 * 这是「无副作用」能力：不读写文件、不执行命令；因此 provider 直接 self-grant，不弹权限框。
 */

export const INTERACTION_TOOL_NAMES = Object.freeze({
  requestUserInput: 'request_user_input',
});

const REQUEST_USER_INPUT_PROMPT = [
  'Ask the user a question and stop the current turn to wait for their reply.',
  'Call this whenever you need a decision, clarification, approval, or a choice from the user',
  '(for example: "commit as 1, 2, or 3?"). Do NOT keep running other tools or make the choice',
  'on the user\'s behalf in the same turn — calling this tool ends your turn and returns control',
  'to the user. Put the actual question (and any options) in the arguments so the user sees it.',
].join(' ');

export const INTERACTION_TOOL_DEFINITIONS = [
  {
    name: INTERACTION_TOOL_NAMES.requestUserInput,
    capabilityId: 'local.interaction.request_user_input',
    prompt: () => REQUEST_USER_INPUT_PROMPT,
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-interaction-provider',
      executorCapabilityId: 'local.interaction.request_user_input',
    }),
    permissionPolicy: {
      kind: 'interaction',
    },
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
          description: 'Optional list of discrete choices the user can pick from (e.g. ["1", "2", "3"]).',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];
