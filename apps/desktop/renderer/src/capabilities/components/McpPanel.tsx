import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

interface McpLocalItem {
  readonly mcpId: number | string;
  readonly name: string;
  readonly description?: string;
  readonly serverUrl?: string;
  readonly tools?: readonly { toolName: string; toolDesc?: string }[];
  readonly enabled?: boolean;
}

export function McpPanel({
  onMcpCountChange,
}: {
  readonly onMcpCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<readonly McpLocalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverUrl, setServerUrl] = useState('');
  const [serverName, setServerName] = useState('');
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = (await clientApi.mcpListInstalled()) as unknown as readonly McpLocalItem[];
      setItems(list);
      onMcpCountChange?.(list.length);
    } catch { /* silent */ }
  }, [onMcpCountChange]);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const handleConnect = useCallback(async () => {
    if (!serverUrl.trim() || !serverName.trim()) return;
    setConnecting(true);
    try {
      await clientApi.mcpConnectAndRegister({ serverUrl: serverUrl.trim(), serverName: serverName.trim() });
      setServerUrl('');
      setServerName('');
      await refresh();
    } catch {
      // TODO: show error
    } finally {
      setConnecting(false);
    }
  }, [serverUrl, serverName, refresh]);

  const handleUninstall = useCallback(async (mcpId: number | string) => {
    await clientApi.mcpUninstall({ mcpId: String(mcpId) });
    await refresh();
  }, [refresh]);

  if (loading) return <p className="runtime-note">Loading MCP servers...</p>;

  return (
    <div className="mcp-panel">
      <div className="mcp-connect-form">
        <input
          placeholder="Server Name"
          value={serverName}
          onChange={(e) => setServerName(e.target.value)}
        />
        <input
          placeholder="Server URL (e.g. http://localhost:3000/mcp)"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <button type="button" onClick={handleConnect} disabled={connecting || !serverUrl.trim() || !serverName.trim()}>
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
      </div>
      {items.length === 0 ? (
        <p className="runtime-note">No MCP servers installed.</p>
      ) : (
        <ul className="mcp-list">
          {items.map((item) => (
            <li key={String(item.mcpId)}>
              <strong>{item.name}</strong>
              {item.serverUrl ? <small>{item.serverUrl}</small> : null}
              {item.tools?.length ? <span>{item.tools.length} tools</span> : null}
              <button type="button" onClick={() => handleUninstall(item.mcpId)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
