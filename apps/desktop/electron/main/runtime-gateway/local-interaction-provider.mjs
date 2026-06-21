import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';

/**
 * 本地 Interaction 能力 Provider —— 见 request_user_input 设计。
 *
 * 设计要点（与 AGENTS.md 非协商运行时链一致）：
 * - 这是一个「无副作用」的本地能力：它不读写文件、不执行命令，只把 agent
 *   想向用户提出的问题登记为 Evidence，并在结果里附带一个「终止回合」的控制信号。
 * - 经正规链路暴露：Capability Provider → Manifest → Runtime Projection → Tool Call
 *   → PermissionGrant → Evidence。因为无副作用，provider 自身直接 self-grant，
 *   不弹权限框（与 goal_update_task 一致）。
 * - 关键作用：把「agent 在向用户提问、需要等待用户输入」从「模型自觉只输出纯文本」
 *   升级为「运行时可识别的终止信号」。agent loop 读到该信号后停止回灌工具结果、
 *   交还控制权给用户，而不是自行继续决策（详见 anthropic/openai-agent-loop.mjs）。
 *
 * 该 provider 本身不决定是否停止——它只产出 control.terminal 标记；停止动作由
 * agent loop 在「所有 tool_use 都已配对 tool_result 之后」执行，以保证多轮消息合法。
 */

export const INTERACTION_CAPABILITY_ID = 'local.interaction.request_user_input';

function parseArgs(call) {
  const raw = call?.arguments;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

export function createLocalInteractionProvider() {
  async function executeCapability(request, context = {}) {
    const call = request.call;
    const locale = context.locale ?? 'zh-CN';
    const args = parseArgs(call);

    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const options = Array.isArray(args.options)
      ? args.options.filter((opt) => typeof opt === 'string' && opt.trim()).map((opt) => opt.trim())
      : [];

    const status = question ? 'success' : 'failed';

    const payload = question
      ? {
          ok: true,
          acknowledged: true,
          question,
          options,
          // agent 不需要据此「自己回答」；这是给用户看的待决问题。
          note:
            locale === 'zh-CN'
              ? '已向用户提出问题，本回合在此停止，等待用户输入后再继续。'
              : 'Question surfaced to the user. The turn stops here and waits for the user to reply.',
        }
      : {
          ok: false,
          error:
            locale === 'zh-CN'
              ? 'request_user_input 需要非空的 question 参数。'
              : 'request_user_input requires a non-empty "question" argument.',
        };

    const output = JSON.stringify(payload);

    return {
      call,
      grant: createPermissionGrant({
        toolCallId: call.toolCallId,
        granted: status === 'success',
        scope: INTERACTION_CAPABILITY_ID,
      }),
      result: {
        toolCallId: call.toolCallId,
        status,
        outputPreview: {
          status,
          tool: 'request_user_input',
          // 终止控制信号：仅当成功登记问题时才要求 loop 停下来等用户。
          control: status === 'success' ? { terminal: true, reason: 'request_user_input' } : null,
          legacyResult: { success: status === 'success', output },
        },
        evidence: {
          evidenceId: `interaction-${call.toolCallId}`,
          toolCallId: call.toolCallId,
          summary:
            status === 'success'
              ? locale === 'zh-CN'
                ? `已向用户提问并暂停回合：${question}`
                : `Asked the user and paused the turn: ${question}`
              : locale === 'zh-CN'
                ? 'request_user_input 调用缺少 question，未暂停。'
                : 'request_user_input call missing question; not paused.',
          locale,
          returnedToCloud: false,
          dataLevel: 'D0_public',
          redactions: [],
          artifactRefs: [],
        },
        completedAt: nowIso(),
      },
    };
  }

  return {
    providerId: INTERACTION_CAPABILITY_ID,
    capabilityIds: [INTERACTION_CAPABILITY_ID],
    executeCapability,
  };
}
