import type { ClientToolCall } from '@peer-agent/protocol';

/**
 * M3·G —— "一直允许"的命令签名。
 *
 * 用稳定签名（忽略易变 args）做会话级白名单匹配，而非完整命令字符串：
 * - aone-kit / a1：到 `call-tool <tool-id>` 粒度 —— 同 tool-id 不同查询参数都放行，
 *   换 tool-id（尤其写操作）仍需确认。
 * - 一般 shell：`程序 + 首个子命令`（去路径）。
 * - 无可识别命令：退化为 capabilityId（仍按 capability 维度记忆）。
 *
 * 详见 knowledge/definition/2026-05-29-本地Skill执行模型对齐ClaudeCode方案.md §5.9。
 */
export function buildClientToolCommandSignature(call: ClientToolCall): string {
  const capabilityId = call.capabilityId;
  if (capabilityId === 'local.file.edit' || capabilityId === 'local.file.write') {
    return capabilityId;
  }
  const command = extractCommand(call.argumentsPreview);
  if (!command) return capabilityId;
  return `${capabilityId}::${normalizeCommandSignature(command)}`;
}

function extractCommand(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const candidate =
    typeof record.command === 'string'
      ? record.command
      : typeof record.cmd === 'string'
        ? record.cmd
        : typeof record.script === 'string'
          ? record.script
          : '';
  return candidate.trim();
}

function normalizeCommandSignature(command: string): string {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const base = tokens[0].split('/').pop() ?? tokens[0];
  // aone-kit / a1 call-tool <tool-id>：到 tool-id 粒度
  if (
    (base === 'aone-kit' || base === 'a1') &&
    tokens[1] === 'call-tool' &&
    tokens[2]
  ) {
    return `${base} call-tool ${tokens[2]}`;
  }
  // 一般命令：程序 + 首个非 flag 子命令
  const sub = tokens.slice(1).find((token) => !token.startsWith('-'));
  return sub ? `${base} ${sub}` : base;
}
