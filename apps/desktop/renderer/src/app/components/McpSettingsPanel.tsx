import type { LocalMcpServerUpsertRequest } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';

type McpTransportKind = 'streamable_http' | 'sse' | 'stdio';

type McpToolView = {
  readonly name?: string;
  readonly toolName?: string;
  readonly description?: string;
  readonly toolDesc?: string;
  readonly visible?: boolean;
};

type McpResourceView = {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
};

type McpPromptView = {
  readonly name: string;
  readonly description?: string;
};

type McpAuthMode = 'none' | 'http_bearer' | 'http_header' | 'stdio_env';

type McpCredentialView = {
  readonly credentialRef: string;
  readonly label: string;
  readonly kind: Exclude<McpAuthMode, 'none'>;
  readonly headerName?: string;
  readonly envName?: string;
  readonly lastFour?: string;
  readonly storage?: string;
};

type McpServerView = {
  readonly id?: string | number;
  readonly mcpId?: string | number;
  readonly displayName?: string;
  readonly name?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly transport?: McpTransportKind;
  readonly commandPreview?: string;
  readonly urlPreview?: string;
  readonly serverUrl?: string;
  readonly auth?: { readonly mode?: McpAuthMode; readonly credentialRef?: string; readonly headerName?: string; readonly envName?: string };
  readonly toolsCount?: number;
  readonly visibleToolsCount?: number;
  readonly resourcesCount?: number;
  readonly promptsCount?: number;
  readonly tools?: readonly McpToolView[];
  readonly resources?: readonly McpResourceView[];
  readonly prompts?: readonly McpPromptView[];
  readonly health?: { readonly status?: string; readonly checkedAt?: string | null; readonly message?: string };
  readonly manifestUpdatedAt?: string | null;
  readonly lastError?: string | null;
};

function serverIdOf(server: McpServerView): string {
  return String(server.id ?? server.mcpId ?? '');
}

function toolNameOf(tool: McpToolView): string {
  return String(tool.name ?? tool.toolName ?? '');
}

function labelForServer(server: McpServerView): string {
  return String(server.displayName ?? server.name ?? serverIdOf(server));
}

function transportLabel(transport?: McpTransportKind): string {
  if (transport === 'stdio') return 'stdio';
  if (transport === 'sse') return 'SSE';
  return 'streamable HTTP';
}

export function McpSettingsPanel() {
  const [servers, setServers] = useState<readonly McpServerView[]>([]);
  const [credentials, setCredentials] = useState<readonly McpCredentialView[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [transport, setTransport] = useState<McpTransportKind>('streamable_http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [cwd, setCwd] = useState('');
  const [authMode, setAuthMode] = useState<McpAuthMode>('none');
  const [credentialLabel, setCredentialLabel] = useState('');
  const [credentialSecret, setCredentialSecret] = useState('');
  const [authHeaderName, setAuthHeaderName] = useState('X-API-Key');
  const [authEnvName, setAuthEnvName] = useState('MCP_TOKEN');
  const [selectedId, setSelectedId] = useState<string>('');
  const [resourcePreview, setResourcePreview] = useState('');
  const [promptPreview, setPromptPreview] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => servers.find((server) => serverIdOf(server) === selectedId) ?? servers[0] ?? null,
    [selectedId, servers],
  );

  const load = useCallback(async () => {
    const [list, credentialList] = await Promise.all([
      clientApi.mcpListInstalled() as Promise<readonly McpServerView[]>,
      clientApi.mcpListCredentials() as Promise<readonly McpCredentialView[]>,
    ]);
    setServers(list);
    setCredentials(credentialList);
    setSelectedId((current) => current || (list[0] ? serverIdOf(list[0]) : ''));
  }, []);

  useEffect(() => {
    void load().catch((error) => setStatus(error?.message ?? '加载 MCP 连接失败'));
  }, [load]);

  useEffect(() => {
    if (transport === 'stdio' && (authMode === 'http_bearer' || authMode === 'http_header')) setAuthMode('none');
    if (transport !== 'stdio' && authMode === 'stdio_env') setAuthMode('none');
  }, [authMode, transport]);

  const resetForm = useCallback(() => {
    setDisplayName('');
    setTransport('streamable_http');
    setUrl('');
    setCommand('');
    setArgsText('');
    setCwd('');
    setAuthMode('none');
    setCredentialLabel('');
    setCredentialSecret('');
    setAuthHeaderName('X-API-Key');
    setAuthEnvName('MCP_TOKEN');
  }, []);

  const handleSave = useCallback(async () => {
    setBusy(true);
    setStatus('保存 MCP 连接中…');
    try {
      const args = argsText.split(/\s+/).map((item) => item.trim()).filter(Boolean);
      let auth: LocalMcpServerUpsertRequest['auth'] = { mode: 'none' };
      if (authMode !== 'none') {
        if (!credentialSecret.trim()) throw new Error('请填写 MCP 凭证。');
        const credential = await clientApi.mcpPutCredential({
          label: credentialLabel.trim() || `${displayName.trim() || 'MCP'} ${authMode}`,
          kind: authMode,
          secret: credentialSecret,
          headerName: authMode === 'http_header' ? authHeaderName.trim() : undefined,
          envName: authMode === 'stdio_env' ? authEnvName.trim() : undefined,
        });
        auth = {
          mode: authMode,
          credentialRef: credential.credentialRef,
          headerName: authMode === 'http_header' ? authHeaderName.trim() : undefined,
          envName: authMode === 'stdio_env' ? authEnvName.trim() : undefined,
        };
      }
      const base = {
        displayName: displayName.trim() || (transport === 'stdio' ? command.trim() : url.trim()),
        transport,
        enabled: true,
      } satisfies Pick<LocalMcpServerUpsertRequest, 'displayName' | 'transport' | 'enabled'>;
      const item: LocalMcpServerUpsertRequest = transport === 'stdio'
        ? {
          ...base,
          command: command.trim(),
          args,
          cwd: cwd.trim() || null,
          auth,
        }
        : {
          ...base,
          url: url.trim(),
          serverUrl: url.trim(),
          auth,
        };
      await clientApi.mcpUpsertServer(item);
      resetForm();
      await load();
      setStatus('MCP 连接和认证绑定已保存。点击“刷新 Manifest”后才会进入 Runtime Projection。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存 MCP 连接失败');
    } finally {
      setBusy(false);
    }
  }, [argsText, authEnvName, authHeaderName, authMode, command, credentialLabel, credentialSecret, cwd, displayName, load, resetForm, transport, url]);

  const runServerAction = useCallback(async (message: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setStatus(`${message}…`);
    try {
      await action();
      await load();
      setStatus(`${message}完成。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `${message}失败`);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const handleReadResource = useCallback(async (uri: string) => {
    if (!selected) return;
    setBusy(true);
    setStatus('读取 resource…');
    try {
      const result = await clientApi.mcpReadResource({ serverId: serverIdOf(selected), uri });
      setResourcePreview(JSON.stringify(result, null, 2));
      setStatus('Resource 已读取；该内容不会自动进入 system prompt。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '读取 resource 失败');
    } finally {
      setBusy(false);
    }
  }, [selected]);

  const handleGetPrompt = useCallback(async (name: string) => {
    if (!selected) return;
    setBusy(true);
    setStatus('获取 prompt…');
    try {
      const result = await clientApi.mcpGetPrompt({ serverId: serverIdOf(selected), name, arguments: {} });
      setPromptPreview(JSON.stringify(result, null, 2));
      setStatus('Prompt 已获取；该内容仅作为用户可见管理预览，不会提升为 system 指令。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '获取 prompt 失败');
    } finally {
      setBusy(false);
    }
  }, [selected]);

  return (
    <div className="settings-panel settings-panel--mcp">
      <header className="settings-panel__header">
        <div>
          <h2>MCP 连接</h2>
          <p>管理本地 MCP server。工具必须先刷新 Manifest，再经 Runtime Projection、PermissionGrant 和 Evidence 链路执行。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={busy}>刷新列表</button>
      </header>

      <section className="settings-card">
        <h3>新增本地 MCP server</h3>
        <div className="settings-grid settings-grid--two">
          <label>
            名称
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="filesystem / sentry / internal-tools" />
          </label>
          <label>
            Transport
            <select value={transport} onChange={(event) => setTransport(event.target.value as McpTransportKind)}>
              <option value="streamable_http">streamable HTTP</option>
              <option value="sse">SSE</option>
              <option value="stdio">stdio</option>
            </select>
          </label>
          {transport !== 'stdio' ? (
            <label className="settings-grid__wide">
              Server URL
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:3000/mcp" />
            </label>
          ) : (
            <>
              <label>
                Command
                <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx / uvx / node" />
              </label>
              <label>
                Args
                <input value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /tmp" />
              </label>
              <label className="settings-grid__wide">
                CWD（可选）
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/Users/me/project" />
              </label>
            </>
          )}
          <label>
            认证方式
            <select value={authMode} onChange={(event) => setAuthMode(event.target.value as McpAuthMode)}>
              <option value="none">无需认证</option>
              <option value="http_bearer" disabled={transport === 'stdio'}>HTTP Bearer Token</option>
              <option value="http_header" disabled={transport === 'stdio'}>HTTP 自定义 Header</option>
              <option value="stdio_env" disabled={transport !== 'stdio'}>stdio 环境变量</option>
            </select>
          </label>
          {authMode !== 'none' ? (
            <>
              <label>
                凭证名称
                <input value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} placeholder="GitHub token / Sentry key" />
              </label>
              <label>
                Secret（仅写入 main 进程凭证库）
                <input type="password" value={credentialSecret} onChange={(event) => setCredentialSecret(event.target.value)} placeholder="不会保存到 renderer 状态以外的明文配置" />
              </label>
              {authMode === 'http_header' ? (
                <label>
                  Header Name
                  <input value={authHeaderName} onChange={(event) => setAuthHeaderName(event.target.value)} placeholder="X-API-Key" />
                </label>
              ) : null}
              {authMode === 'stdio_env' ? (
                <label>
                  Env Name
                  <input value={authEnvName} onChange={(event) => setAuthEnvName(event.target.value)} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN" />
                </label>
              ) : null}
            </>
          ) : null}
        </div>
        <p className="settings-muted">认证 Secret 只通过 IPC 送入 main 进程凭证库；registry 和 renderer 只保留 credentialRef、lastFour、authMode 等非密信息。</p>
        <div className="settings-actions">
          <button type="button" onClick={() => void handleSave()} disabled={busy || (!url.trim() && !command.trim())}>保存连接</button>
        </div>
      </section>

      {status ? <p className="settings-status">{status}</p> : null}

      <section className="settings-card">
        <h3>本地 MCP 凭证库</h3>
        {credentials.length === 0 ? (
          <p className="settings-empty">还没有保存 MCP 凭证。保存带认证的连接时会自动创建凭证。</p>
        ) : (
          <ul className="mcp-server-list">
            {credentials.map((credential) => (
              <li key={credential.credentialRef}>
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(credential.credentialRef); }}>
                  <strong>{credential.label}</strong>
                  <span>{credential.kind} · {credential.storage ?? 'credential-store'} · ****{credential.lastFour ?? ''}</span>
                  <small>{credential.headerName ? `header: ${credential.headerName}` : credential.envName ? `env: ${credential.envName}` : credential.credentialRef}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-card">
        <h3>已配置连接</h3>
        {servers.length === 0 ? (
          <p className="settings-empty">还没有 MCP 连接。</p>
        ) : (
          <div className="mcp-settings-layout">
            <ul className="mcp-server-list">
              {servers.map((server) => {
                const id = serverIdOf(server);
                const active = selected && serverIdOf(selected) === id;
                return (
                  <li key={id} className={active ? 'is-active' : ''}>
                    <button type="button" onClick={() => setSelectedId(id)}>
                      <strong>{labelForServer(server)}</strong>
                      <span>{transportLabel(server.transport)} · {server.enabled === false ? 'disabled' : 'enabled'}</span>
                      <small>{server.toolsCount ?? server.tools?.length ?? 0} tools · {server.resourcesCount ?? server.resources?.length ?? 0} resources · {server.promptsCount ?? server.prompts?.length ?? 0} prompts</small>
                    </button>
                  </li>
                );
              })}
            </ul>

            {selected ? (
              <div className="mcp-server-detail">
                <header>
                  <div>
                    <h4>{labelForServer(selected)}</h4>
                    <p>{selected.urlPreview || selected.serverUrl || selected.commandPreview || selected.description || '本地 MCP server'}</p>
                  </div>
                  <span className={`mcp-health mcp-health--${selected.health?.status ?? 'unknown'}`}>{selected.health?.status ?? 'unknown'}</span>
                </header>
                {selected.health?.message ? <p className="settings-warning">{selected.health.message}</p> : null}
                {selected.lastError ? <p className="settings-warning">{selected.lastError}</p> : null}
                <p className="settings-muted">认证：{selected.auth?.mode ?? 'none'}{selected.auth?.credentialRef ? ` · ${selected.auth.credentialRef}` : ''}</p>
                <div className="settings-actions settings-actions--wrap">
                  <button type="button" disabled={busy} onClick={() => void runServerAction('测试连接', () => clientApi.mcpTestConnection({ serverId: serverIdOf(selected) }))}>测试连接</button>
                  <button type="button" disabled={busy} onClick={() => void runServerAction('刷新 Manifest', () => clientApi.mcpRefreshManifest({ serverId: serverIdOf(selected) }))}>刷新 Manifest</button>
                  <button type="button" disabled={busy} onClick={() => void runServerAction(selected.enabled === false ? '启用连接' : '禁用连接', () => clientApi.mcpSetEnabled({ serverId: serverIdOf(selected), enabled: selected.enabled === false }))}>{selected.enabled === false ? '启用' : '禁用'}</button>
                  <button type="button" disabled={busy} onClick={() => void runServerAction('移除连接', () => clientApi.mcpUninstall({ serverId: serverIdOf(selected) }))}>移除</button>
                </div>

                <section>
                  <h5>Tools（进入 Runtime Projection）</h5>
                  {selected.tools?.length ? (
                    <ul className="mcp-tool-list">
                      {selected.tools.map((tool) => {
                        const toolName = toolNameOf(tool);
                        return (
                          <li key={toolName}>
                            <div>
                              <strong>{toolName}</strong>
                              <p>{tool.description ?? tool.toolDesc ?? 'No description'}</p>
                            </div>
                            <label className="mcp-toggle">
                              <input
                                type="checkbox"
                                checked={tool.visible !== false}
                                onChange={(event) => void runServerAction('更新工具可见性', () => clientApi.mcpSetToolVisibility({
                                  serverId: serverIdOf(selected),
                                  toolName,
                                  visible: event.target.checked,
                                }))}
                              />
                              visible
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  ) : <p className="settings-empty">尚未发现工具。请刷新 Manifest。</p>}
                </section>

                <section>
                  <h5>Resources（只读管理预览）</h5>
                  {selected.resources?.length ? (
                    <ul className="mcp-resource-list">
                      {selected.resources.map((resource) => (
                        <li key={resource.uri}>
                          <button type="button" disabled={busy} onClick={() => void handleReadResource(resource.uri)}>{resource.name || resource.uri}</button>
                          <small>{resource.uri}</small>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="settings-empty">尚未发现 resources。</p>}
                  {resourcePreview ? <pre className="mcp-preview">{resourcePreview}</pre> : null}
                </section>

                <section>
                  <h5>Prompts（只做用户可见预览）</h5>
                  {selected.prompts?.length ? (
                    <ul className="mcp-resource-list">
                      {selected.prompts.map((prompt) => (
                        <li key={prompt.name}>
                          <button type="button" disabled={busy} onClick={() => void handleGetPrompt(prompt.name)}>{prompt.name}</button>
                          <small>{prompt.description ?? ''}</small>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="settings-empty">尚未发现 prompts。</p>}
                  {promptPreview ? <pre className="mcp-preview">{promptPreview}</pre> : null}
                </section>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
