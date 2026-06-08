import type { McpDingtalkMarketDetail } from '../../../preload/contracts/bootstrapPreloadApi';

export function McpDetailSidebar({
  detail,
  loading,
  installed,
  onInstall,
  onUninstall,
  onClose,
}: {
  readonly detail: McpDingtalkMarketDetail | null;
  readonly loading: boolean;
  readonly installed: boolean;
  readonly onInstall: () => void;
  readonly onUninstall: () => void;
  readonly onClose: () => void;
}) {
  if (loading) {
    return (
      <aside className="mcp-sidebar">
        <header>
          <div />
          <button type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="mcp-loading">加载中…</div>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="mcp-sidebar">
        <header>
          <div />
          <button type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <p className="mcp-detail-empty-tools">加载失败</p>
      </aside>
    );
  }

  return (
    <aside className="mcp-sidebar">
      <header>
        <div>
          <h3>{detail.name}</h3>
          {detail.providerCorpName && (
            <span className="mcp-sidebar-provider">{detail.providerCorpName}</span>
          )}
        </div>
        <button type="button" aria-label="关闭" onClick={onClose}>×</button>
      </header>

      {detail.description && (
        <section className="mcp-sidebar-section">
          <p>{detail.description}</p>
        </section>
      )}

      {installed && detail.dingtalkActivation && (
        <section className="mcp-sidebar-section">
          <h4>接入信息</h4>
          <dl className="mcp-sidebar-meta">
            {detail.dingtalkActivation.instanceId !== undefined && (
              <>
                <dt>instanceId</dt>
                <dd>{detail.dingtalkActivation.instanceId}</dd>
              </>
            )}
            {detail.dingtalkActivation.mcpInstanceId && (
              <>
                <dt>mcpInstanceId</dt>
                <dd>{detail.dingtalkActivation.mcpInstanceId}</dd>
              </>
            )}
            {detail.dingtalkActivation.serverUrl && (
              <>
                <dt>serverUrl</dt>
                <dd>{detail.dingtalkActivation.serverUrl}</dd>
              </>
            )}
            {detail.dingtalkActivation.activatedAt && (
              <>
                <dt>activatedAt</dt>
                <dd>{detail.dingtalkActivation.activatedAt}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      <section className="mcp-sidebar-section">
        <h4>工具 ({detail.tools.length})</h4>
        {detail.tools.length > 0 ? (
          <ul className="mcp-sidebar-tools">
            {detail.tools.map((tool) => (
              <li key={tool.toolName}>
                <code>{tool.toolName}</code>
                {tool.toolDesc && <span>{tool.toolDesc}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mcp-detail-empty-tools">该 MCP 未提供工具定义。</p>
        )}
      </section>

      <footer className="mcp-sidebar-footer">
        {installed ? (
          <button type="button" className="mcp-btn-danger" onClick={onUninstall}>
            移除
          </button>
        ) : (
          <button type="button" className="mcp-btn-primary" onClick={onInstall}>
            接入
          </button>
        )}
      </footer>
    </aside>
  );
}
