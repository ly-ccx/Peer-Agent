import type { CapabilityWorkbenchTab } from '../types';

const EMPTY_COPY: Record<CapabilityWorkbenchTab, { title: string; body: string }> = {
  skills: {
    title: '暂无真实 Skill 数据',
    body: '当前客户端还没有接入云端 Skill 目录；接入后只展示云端返回的真实能力。',
  },
  mcp: {
    title: '暂无真实 MCP 数据',
    body: '当前本地 registry 没有 MCP manifest；安装或注册本地 MCP 后会在这里出现。',
  },
};

export function CapabilityEmptyState({
  tab,
}: {
  readonly tab: CapabilityWorkbenchTab;
}) {
  const copy = EMPTY_COPY[tab];

  return (
    <section className="capability-empty-state" aria-label={copy.title}>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
    </section>
  );
}
