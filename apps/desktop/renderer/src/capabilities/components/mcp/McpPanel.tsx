import type {
  McpDingtalkActivationInfo,
  McpDingtalkActivationResponse,
  McpDingtalkMarketDetail,
  McpLocalRegistryItem,
} from '../../../preload/contracts/bootstrapPreloadApi';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../../clientApi';
import { McpSubTabs, type McpSubTab } from './McpSubTabs';
import { McpInstalledPanel } from './McpInstalledPanel';
import { McpDingtalkMarketPanel } from './McpDingtalkMarketPanel';
import { McpAonePanel } from './McpAonePanel';
import { McpDetailSidebar } from './McpDetailSidebar';

interface SidebarState {
  readonly detail: McpDingtalkMarketDetail | null;
  readonly loading: boolean;
  readonly installed: boolean;
}

function firstMcpServerUrl(mcpJSON?: string): string | undefined {
  if (!mcpJSON) return undefined;
  try {
    const parsed = JSON.parse(mcpJSON) as {
      serverUrl?: unknown;
      mcpServers?: Record<string, { url?: unknown; serverUrl?: unknown }>;
    };
    if (typeof parsed.serverUrl === 'string') return parsed.serverUrl;
    const servers = parsed.mcpServers ? Object.values(parsed.mcpServers) : [];
    for (const server of servers) {
      if (typeof server.url === 'string') return server.url;
      if (typeof server.serverUrl === 'string') return server.serverUrl;
    }
  } catch {
    /* keep activation raw even if mcpJSON shape changes */
  }
  return undefined;
}

function toDingtalkActivationInfo(response: McpDingtalkActivationResponse): McpDingtalkActivationInfo | undefined {
  const result = response.result;
  if (!result) return undefined;
  const mcpJSON = typeof result.mcpJSON === 'string' ? result.mcpJSON : undefined;
  return {
    instanceId: typeof result.instanceId === 'number' ? result.instanceId : undefined,
    mcpInstanceId: typeof result.mcpInstanceId === 'string' ? result.mcpInstanceId : undefined,
    mcpJSON,
    serverUrl: firstMcpServerUrl(mcpJSON),
    activatedAt: new Date().toISOString(),
    raw: result,
  };
}

export function McpPanel({
  onMcpCountChange,
}: {
  readonly onMcpCountChange?: (count: number) => void;
}) {
  const [activeTab, setActiveTab] = useState<McpSubTab>('installed');
  const [sidebar, setSidebar] = useState<SidebarState | null>(null);
  const [selectedMcpId, setSelectedMcpId] = useState<number | null>(null);
  const [installedItems, setInstalledItems] = useState<readonly McpLocalRegistryItem[]>([]);
  const [installedLoading, setInstalledLoading] = useState(true);
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);

  const refreshInstalled = useCallback(async () => {
    try {
      const list = await clientApi.mcpListInstalled();
      setInstalledItems(list);
      onMcpCountChange?.(list.length);
      return list;
    } catch { /* silent */ }
    return [];
  }, [onMcpCountChange]);

  useEffect(() => {
    void refreshInstalled().finally(() => setInstalledLoading(false));
  }, [refreshInstalled]);

  const openDetail = useCallback(async (mcpId: number) => {
    if (mcpId === selectedMcpId) {
      setSidebar(null);
      setSelectedMcpId(null);
      return;
    }
    setSelectedMcpId(mcpId);

    const items = installedItems.length > 0 ? installedItems : await refreshInstalled();
    const localItem = items.find((i) => i.mcpId === mcpId);
    if (localItem) {
      setSidebar({
        detail: {
          mcpId: localItem.mcpId,
          name: localItem.name,
          description: localItem.description,
          icon: localItem.icon,
          providerCorpName: localItem.providerCorpName,
          tools: localItem.tools,
          dingtalkActivation: localItem.dingtalkActivation,
        },
        loading: false,
        installed: true,
      });
      return;
    }

    setSidebar({ detail: null, loading: true, installed: false });
    try {
      const result = await clientApi.mcpGetDingtalkDetail({ mcpId });
      const isInstalled = items.some((i) => i.mcpId === mcpId);
      setSidebar({ detail: result, loading: false, installed: isInstalled });
    } catch {
      setSidebar({ detail: null, loading: false, installed: false });
    }
  }, [selectedMcpId, installedItems, refreshInstalled]);

  const handleInstall = useCallback(async () => {
    if (!sidebar?.detail) return;
    const d = sidebar.detail;
    const activation = toDingtalkActivationInfo(await clientApi.mcpDingtalkActivate({ mcpId: d.mcpId }));
    await clientApi.mcpInstall({
      mcpId: d.mcpId,
      name: d.name,
      description: d.description,
      icon: d.icon,
      providerCorpName: d.providerCorpName,
      source: 'dingtalk',
      serverUrl: activation?.serverUrl,
      tools: d.tools,
      dingtalkActivation: activation,
    });
    setSidebar({
      ...sidebar,
      detail: { ...d, dingtalkActivation: activation },
      installed: true,
    });
    await refreshInstalled();
    setMarketRefreshKey((value) => value + 1);
  }, [sidebar, refreshInstalled]);

  const handleDirectInstall = useCallback(async (mcpId: number) => {
    try {
      const detail = await clientApi.mcpGetDingtalkDetail({ mcpId });
      if (!detail) return;
      const activation = toDingtalkActivationInfo(await clientApi.mcpDingtalkActivate({ mcpId }));
      await clientApi.mcpInstall({
        mcpId: detail.mcpId,
        name: detail.name,
        description: detail.description,
        icon: detail.icon,
        providerCorpName: detail.providerCorpName,
        source: 'dingtalk',
        serverUrl: activation?.serverUrl,
        tools: detail.tools,
        dingtalkActivation: activation,
      });
      await refreshInstalled();
      setMarketRefreshKey((value) => value + 1);
    } catch {
      // TODO: show error
    }
  }, [refreshInstalled]);

  const installedAoneCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const item of installedItems) {
      if (item.source === 'aone' && item.serverUrl) {
        const match = item.serverUrl.match(/mcp\.alibaba-inc\.com\/([^/]+)\//);
        if (match) codes.add(match[1]);
      }
    }
    return codes;
  }, [installedItems]);

  const handleAoneInstall = useCallback(async (serverName: string) => {
    const serverUrl = `https://mcp.alibaba-inc.com/${serverName}/mcp`;
    await clientApi.mcpConnectAndRegister({ serverUrl, serverName });
    await refreshInstalled();
    setMarketRefreshKey((v) => v + 1);
  }, [refreshInstalled]);

  const handleUninstall = useCallback(async () => {
    if (!selectedMcpId) return;
    await clientApi.mcpUninstall({ mcpId: selectedMcpId });
    setSidebar(null);
    setSelectedMcpId(null);
    await refreshInstalled();
    setMarketRefreshKey((value) => value + 1);
  }, [selectedMcpId, refreshInstalled]);

  const closeSidebar = useCallback(() => {
    setSidebar(null);
    setSelectedMcpId(null);
  }, []);

  return (
    <div className={`mcp-panel ${sidebar ? 'has-sidebar' : ''}`}>
      <div className="mcp-panel-main">
        <McpSubTabs activeTab={activeTab} onChange={setActiveTab} />
        <div className="mcp-panel-content">
          {activeTab === 'installed' && (
            <McpInstalledPanel
              items={installedItems}
              loading={installedLoading}
              selectedMcpId={selectedMcpId}
              onSelectMcp={openDetail}
            />
          )}
          {activeTab === 'dingtalk' && (
            <McpDingtalkMarketPanel
              refreshKey={marketRefreshKey}
              selectedMcpId={selectedMcpId}
              onSelectMcp={openDetail}
              onInstallMcp={handleDirectInstall}
            />
          )}
          {activeTab === 'aone' && (
            <McpAonePanel
              installedCodes={installedAoneCodes}
              onInstall={handleAoneInstall}
            />
          )}
        </div>
      </div>
      {sidebar && (
        <McpDetailSidebar
          detail={sidebar.detail}
          loading={sidebar.loading}
          installed={sidebar.installed}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
          onClose={closeSidebar}
        />
      )}
    </div>
  );
}
