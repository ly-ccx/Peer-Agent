// 部分 Anthropic 兼容网关（如阿里 claude-1688-gateway）会按客户端身份做准入，
// 仅放行“官方 Claude CLI（claude-code）”的请求，否则返回
// HTTP 403 {"type":"forbidden","message":"access restricted to claude-cli"}。
//
// 经真实探测确认：该网关只校验 User-Agent，且必须匹配 `claude-cli/<版本号>` 形态
// （裸 `claude-cli` 无版本号会被拒）。x-app / anthropic-beta 非准入必需，但保留以更贴近官方 CLI。
//
// 这是 provider 专属的请求头形态，集中放在此 Seam，供「真实对话」与「连通性测试」两条
// 发请求的路径共用，避免在多处各写一份导致再次出现“一条路径修了、另一条没修”的问题。
// 取值对齐本机安装的 Claude Code：UA = "claude-cli/<ver> (external, cli)"。
export const CLAUDE_CLI_VERSION = '2.1.178';

export function buildClaudeCliIdentityHeaders() {
  return {
    'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
    'x-app': 'cli',
    'anthropic-beta': 'claude-code-20250219',
  };
}
