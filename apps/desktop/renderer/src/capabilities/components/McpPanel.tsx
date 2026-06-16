import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

interface McpLocalItem {
  readonly id?: number | string;
  readonly mcpId?: number | string;
  readonly displayName?: string;
  readonly name?: string;
  readonly description?: string;
  readonly serverUrl?: string;
  readonly urlPreview?: string;
  readonly commandPreview?: string;
  readonly toolsCount?: number;
  readonly visibleToolsCount?: number;
  readonly resourcesCount?: number;
  readonly promptsCount?: number;
  readonly tools?: readonly { name?: string; toolName?: string; description?: string; toolDesc?: string; visible?: boolean }[];
  readonly enabled?: boolean;
  readonly health?: { readonly status?: string; readonly message?: string };
}

function itemId(item: McpLocalItem): string | number {
  return item.id ?? item.mcpId ?? '';
}

function itemName(item: McpLocalItem): string {
  return String(item.displayName ?? item.name ?? itemId(item));
}

export function McpPanel({
  onMcpCountChange,
}: {
  readonly onMcpCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<readonly McpLocalItem[]>([]);
  const [serverName, setServerName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = (await clientApi.mcpListInstalled()) as unknown as readonly McpLocalItem[];
      setItems(list);
      onMcpCountChange?.(list.length);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to load MCP connections');
    }
  }, [onMcpCountChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleQuickConnect = useCallback(async () => {
    setStatus('Connecting MCP server...');
    try {
      await clientApi.mcpConnectAndRegister({ serverName, serverUrl });
      setServerName('');
      setServerUrl('');
      setStatus('Connected and Manifest refreshed. Tools are now eligible for Runtime Projection.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'MCP connection failed');
    }
  }, [refresh, serverName, serverUrl]);

  const handleUninstall = useCallback(async (id: string | number) => {
    await clientApi.mcpUninstall({ serverId: id });
    await refresh();
  }, [refresh]);

  const handleRefreshManifest = useCallback(async (id: string | number) => {
    setStatus('Refreshing MCP Manifest...');
    try {
      await clientApi.mcpRefreshManifest({ serverId: id });
      setStatus('Manifest refreshed.');
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Manifest refresh failed');
    }
  }, [refresh]);

  return (
    <div className="mcp-panel">
      <div className="capability-card capability-card--mcp-install">
        <strong>Local MCP connection</strong>
        <p>MCP servers are normalized into Capability Manifests before entering Runtime Projection.</p>
        <input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="Server name" />
        <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="Streamable HTTP URL" />
        <button type="button" disabled={!serverName || !serverUrl} onClick={() => void handleQuickConnect()}>Connect + Refresh Manifest</button>
        {status ? <small>{status}</small> : null}
      </div>
      {items.length === 0 ? (
        <p className="capability-empty">No local MCP connections yet. Use Settings → MCP 连接 for full stdio/HTTP management.</p>
      ) : (
        <ul className="mcp-list">
          {items.map((item) => (
            <li key={String(itemId(item))} className="capability-card">
              <strong>{itemName(item)}</strong>
              {item.description ? <p>{item.description}</p> : null}
              <small>{item.urlPreview || item.serverUrl || item.commandPreview}</small>
              <span>
                {item.visibleToolsCount ?? item.toolsCount ?? item.tools?.length ?? 0} visible tools
                {' · '}{item.resourcesCount ?? 0} resources
                {' · '}{item.promptsCount ?? 0} prompts
                {' · '}{item.health?.status ?? 'unknown'}
              </span>
              <div className="capability-actions">
                <button type="button" onClick={() => void handleRefreshManifest(itemId(item))}>Refresh Manifest</button>
                <button type="button" onClick={() => void handleUninstall(itemId(item))}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
