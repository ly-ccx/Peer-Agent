// MCP 自我认知 Source —— 让 Peer Agent 第一反应就知道「我自己就是一个 MCP host」。
//
// 背景（踩坑）：处理「安装 / 配置 / 管理 MCP」类请求时，Agent 曾第一反应去扫描外部
// 客户端（Codex / Claude 桌面版）的配置路径，却没意识到「我正在运行的这些 MCP 工具，
// 本身就是从我自己的注册表加载的」。根因是自我模型里没有「我是 MCP host」这条事实。
//
// 本 Source 每轮把三条动态事实注入 System Context：
//   1. 「你自身（Peer Agent）就是一个 MCP host」——身份认知；
//   2. 本机 MCP 注册表的真实路径——由 registry 句柄动态给出，不写死；
//   3. 已安装的 MCP 清单（名称 / 是否启用 / 工具数）——从 registry 实时读取。
// 并给出行为准则：处理 MCP 安装/配置/管理请求时，默认目标是本机自己的注册表；
// 外部客户端仅在用户明确指定时才用。
//
// 治理（与 AGENTS.md 一致）：
// - 这是事实/能力上下文（L1_AGENT / trust=builtin），描述「我是什么」，不是可被数据覆盖的指令。
// - 数据由 assembler 通过 input.mcpRegistry 句柄注入（B2b），Source 只读、不写盘、不触发授权。
// - available 恒为 true：即便 0 个 server 或句柄缺失，也要声明「我是 host、注册表在此」。

const MAX_SERVERS = 40;

function readHostFacts(registry) {
  const facts = { path: null, servers: [], degraded: false };
  if (!registry || typeof registry.listInstalled !== 'function') {
    facts.degraded = true;
    return facts;
  }
  try {
    if (typeof registry.path === 'function') {
      const p = registry.path();
      facts.path = typeof p === 'string' && p ? p : null;
    }
  } catch {
    facts.path = null;
  }
  try {
    const installed = registry.listInstalled();
    const list = Array.isArray(installed) ? installed : [];
    facts.servers = list.slice(0, MAX_SERVERS).map((s) => ({
      id: typeof s?.id === 'string' ? s.id : '',
      name: typeof s?.displayName === 'string' && s.displayName
        ? s.displayName
        : (typeof s?.name === 'string' ? s.name : (s?.id ?? '')),
      enabled: s?.enabled !== false,
      transport: typeof s?.transport === 'string' ? s.transport : 'unknown',
      toolsCount: Number.isFinite(s?.toolsCount) ? s.toolsCount : 0,
    }));
  } catch {
    facts.servers = [];
    facts.degraded = true;
  }
  return facts;
}

function formatServerLine(s) {
  const state = s.enabled ? 'enabled' : 'disabled';
  const name = s.name || s.id || '(unnamed)';
  return `- ${name} (id=${s.id || 'unknown'}; ${state}; transport=${s.transport}; tools=${s.toolsCount})`;
}

function renderContent(facts) {
  const lines = [
    'MCP host self-awareness (capability fact, scope=turn).',
    'This describes what you are, not a user-overridable instruction.',
    '',
    'You (Peer Agent) are yourself an MCP host. The MCP tools you can call this turn',
    'are loaded from your own local MCP registry — you are not merely a client of',
    'external MCP hosts.',
    '',
    facts.path
      ? `Your MCP registry lives at: ${facts.path}`
      : 'Your MCP registry path is not resolvable this turn (treat it as your own local registry).',
    '',
  ];

  if (facts.servers.length) {
    lines.push(`Installed MCP servers in your own registry (${facts.servers.length}):`);
    for (const s of facts.servers) lines.push(formatServerLine(s));
  } else {
    lines.push('Installed MCP servers in your own registry: none yet.');
  }

  lines.push(
    '',
    'Behavior for MCP install/configure/manage requests:',
    '- Default target is your OWN local registry above — check and act on it FIRST.',
    '- The strongest evidence of where MCP is configured is the tools you are already',
    '  running this turn; reason inward before scanning outward.',
    '- Only touch external client configs (Codex, Claude Desktop, Claude Code) when the',
    '  user explicitly asks for that specific client.',
  );

  return lines.join('\n');
}

export function createMcpHostPromptSource() {
  return {
    id: 'agent.mcp-host',
    layer: 'L1_AGENT',
    priority: 1,
    trust: 'builtin',
    observe(input = {}) {
      return readHostFacts(input.mcpRegistry);
    },
    render(observation) {
      const facts = observation ?? { path: null, servers: [], degraded: false };
      return [{
        id: 'agent.mcp-host',
        layer: 'L1_AGENT',
        priority: 1,
        trust: 'builtin',
        title: 'MCP host self-awareness',
        content: renderContent(facts),
        source: {
          id: 'agent.mcp-host',
          kind: 'mcp-host-self-awareness',
          serverCount: facts.servers.length,
          degraded: facts.degraded === true,
        },
      }];
    },
  };
}
