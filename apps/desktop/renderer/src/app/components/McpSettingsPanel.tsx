import type { LocalMcpServerUpsertRequest } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { Dropdown, type DropdownOption } from './Dropdown';
import { Overlay } from './Overlay';

type McpTransportKind = 'streamable_http' | 'sse' | 'stdio';
type McpAuthMode = 'none' | 'http_bearer' | 'http_header' | 'stdio_env';

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
};

type McpPromptView = {
  readonly name: string;
  readonly description?: string;
};

type McpCredentialView = {
  readonly credentialRef: string;
  readonly label?: string;
  readonly kind?: string;
  readonly authMode?: string;
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
  readonly health?: { readonly status?: string; readonly lastCheckedAt?: string | null };
  readonly manifestUpdatedAt?: string | null;
  readonly lastError?: string | null;
};

function serverIdOf(server: McpServerView): string | number {
  return server.mcpId ?? server.id ?? server.name ?? server.displayName ?? '';
}

function labelForServer(server: McpServerView): string {
  return String(server.displayName ?? server.name ?? serverIdOf(server));
}

function toolNameOf(tool: McpToolView): string {
  return String(tool.name ?? tool.toolName ?? 'unknown');
}

function transportLabel(transport?: McpTransportKind): string {
  if (transport === 'stdio') return 'stdio';
  if (transport === 'sse') return 'SSE';
  return 'streamable HTTP';
}

function authLabel(auth?: McpServerView['auth']): string {
  if (!auth?.mode || auth.mode === 'none') return '无认证';
  if (auth.mode === 'http_bearer') return 'HTTP Bearer';
  if (auth.mode === 'http_header') return `HTTP Header${auth.headerName ? ` · ${auth.headerName}` : ''}`;
  if (auth.mode === 'stdio_env') return `stdio env${auth.envName ? ` · ${auth.envName}` : ''}`;
  return auth.mode;
}

function endpointForServer(server?: McpServerView): string {
  if (!server) return '未选择连接';
  return server.urlPreview || server.serverUrl || server.commandPreview || server.description || '本地 MCP server';
}

function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

type McpSettingsPanelProps = {
  /** 嵌入到能力工作台等容器时隐藏自带 eyebrow + 大标题，避免双标题。 */
  readonly embedded?: boolean;
  /** server 列表加载后回传数量，供外部（如标签页计数）使用。 */
  readonly onServersCountChange?: (count: number) => void;
};

export function McpSettingsPanel({ embedded = false, onServersCountChange }: McpSettingsPanelProps = {}) {
  const [servers, setServers] = useState<readonly McpServerView[]>([]);
  const [credentials, setCredentials] = useState<readonly McpCredentialView[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [transport, setTransport] = useState<McpTransportKind>('streamable_http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [argRows, setArgRows] = useState<readonly string[]>(['']);
  const [envRows, setEnvRows] = useState<readonly { readonly key: string; readonly value: string }[]>([
    { key: '', value: '' },
  ]);
  const [cwd, setCwd] = useState('');
  const [authMode, setAuthMode] = useState<McpAuthMode>('none');
  const [credentialLabel, setCredentialLabel] = useState('');
  const [credentialSecret, setCredentialSecret] = useState('');
  const [authHeaderName, setAuthHeaderName] = useState('X-API-Key');
  const [authEnvName, setAuthEnvName] = useState('MCP_TOKEN');
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [resourcePreview, setResourcePreview] = useState<string | null>(null);
  const [promptPreview, setPromptPreview] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    const [list, credentialList] = await Promise.all([
      clientApi.mcpListInstalled() as Promise<readonly McpServerView[]>,
      clientApi.mcpListCredentials() as Promise<readonly McpCredentialView[]>,
    ]);
    setServers(list);
    setCredentials(credentialList);
    setSelectedId((current) => current ?? (list[0] ? serverIdOf(list[0]) : null));
    onServersCountChange?.(list.length);
  }, [onServersCountChange]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (transport === 'stdio' && (authMode === 'http_bearer' || authMode === 'http_header')) setAuthMode('none');
    if (transport !== 'stdio' && authMode === 'stdio_env') setAuthMode('none');
  }, [authMode, transport]);

  const authModeOptions = useMemo<DropdownOption[]>(() => {
    const options: DropdownOption[] = [{ value: 'none', label: '无认证' }];
    if (transport !== 'stdio') {
      options.push({ value: 'http_bearer', label: 'HTTP Bearer token' });
      options.push({ value: 'http_header', label: 'HTTP custom header' });
    } else {
      options.push({ value: 'stdio_env', label: 'stdio env secret' });
    }
    return options;
  }, [transport]);

  const selected = useMemo(
    () => servers.find((server) => String(serverIdOf(server)) === String(selectedId)) ?? servers[0] ?? null,
    [selectedId, servers],
  );

  const totals = useMemo(() => servers.reduce(
    (summary, server) => ({
      enabled: summary.enabled + (server.enabled !== false ? 1 : 0),
      tools: summary.tools + (server.toolsCount ?? server.tools?.length ?? 0),
      visibleTools: summary.visibleTools + (server.visibleToolsCount ?? server.tools?.filter((tool) => tool.visible !== false).length ?? 0),
      resources: summary.resources + (server.resourcesCount ?? server.resources?.length ?? 0),
      prompts: summary.prompts + (server.promptsCount ?? server.prompts?.length ?? 0),
    }),
    { enabled: 0, tools: 0, visibleTools: 0, resources: 0, prompts: 0 },
  ), [servers]);

  const resetForm = useCallback(() => {
    setDisplayName('');
    setTransport('streamable_http');
    setUrl('');
    setCommand('');
    setArgRows(['']);
    setEnvRows([{ key: '', value: '' }]);
    setCwd('');
    setAuthMode('none');
    setCredentialLabel('');
    setCredentialSecret('');
    setAuthHeaderName('X-API-Key');
    setAuthEnvName('MCP_TOKEN');
  }, []);

  useEffect(() => {
    if (!showAddForm) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        resetForm();
        setShowAddForm(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showAddForm, busy, resetForm]);

  const updateArgRow = useCallback((index: number, value: string) => {
    setArgRows((rows) => rows.map((row, i) => (i === index ? value : row)));
  }, []);
  const addArgRow = useCallback(() => {
    setArgRows((rows) => [...rows, '']);
  }, []);
  const removeArgRow = useCallback((index: number) => {
    setArgRows((rows) => {
      const next = rows.filter((_, i) => i !== index);
      return next.length ? next : [''];
    });
  }, []);

  const updateEnvRow = useCallback((index: number, patch: { readonly key?: string; readonly value?: string }) => {
    setEnvRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);
  const addEnvRow = useCallback(() => {
    setEnvRows((rows) => [...rows, { key: '', value: '' }]);
  }, []);
  const removeEnvRow = useCallback((index: number) => {
    setEnvRows((rows) => {
      const next = rows.filter((_, i) => i !== index);
      return next.length ? next : [{ key: '', value: '' }];
    });
  }, []);

  const handleSave = useCallback(async () => {
    setBusy(true);
    setStatus('保存 MCP 连接中…');
    try {
      const args = argRows.map((item) => item.trim()).filter(Boolean);
      const env = envRows.reduce<Record<string, string>>((acc, row) => {
        const key = row.key.trim();
        if (key) acc[key] = row.value;
        return acc;
      }, {});
      let auth: LocalMcpServerUpsertRequest['auth'] = { mode: 'none' };
      if (authMode !== 'none') {
        if (!credentialSecret.trim()) throw new Error('请填写 MCP 凭证。');
        const credential = await clientApi.mcpPutCredential({
          label: credentialLabel.trim() || displayName.trim() || undefined,
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
          env,
          cwd: cwd.trim() || null,
          auth,
        }
        : {
          ...base,
          url: url.trim(),
          serverUrl: url.trim(),
          auth,
        };
      const saved = await clientApi.mcpUpsertServer(item);
      resetForm();
      setShowAddForm(false);
      await load();
      setSelectedId(serverIdOf(saved as McpServerView));
      setStatus('MCP 连接已保存。请刷新 Manifest 后再让模型使用工具。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存 MCP 连接失败');
    } finally {
      setBusy(false);
    }
  }, [argRows, authEnvName, authHeaderName, authMode, command, credentialLabel, credentialSecret, cwd, displayName, envRows, load, resetForm, transport, url]);

  const runServerAction = useCallback(async (message: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setStatus(`${message}中…`);
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

  const refreshAll = useCallback(async () => {
    setBusy(true);
    const targets = servers.filter((server) => server.enabled !== false);
    if (targets.length === 0) {
      try {
        await load();
        setStatus('暂无启用的 MCP 连接，已重读列表。');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : '刷新列表失败');
      } finally {
        setBusy(false);
      }
      return;
    }
    const failures: string[] = [];
    let done = 0;
    for (const server of targets) {
      const name = labelForServer(server);
      setStatus(`刷新 Manifest 中…（${done + 1}/${targets.length}）${name}`);
      try {
        await clientApi.mcpRefreshManifest({ serverId: serverIdOf(server) });
      } catch (error) {
        failures.push(`${name}：${error instanceof Error ? error.message : '刷新失败'}`);
      }
      done += 1;
    }
    try {
      await load();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : '重读列表失败');
    }
    if (failures.length === 0) {
      setStatus(`已刷新全部 ${targets.length} 个连接的 Manifest。`);
    } else if (failures.length === targets.length) {
      setStatus(`刷新失败：${failures.join('；')}`);
    } else {
      setStatus(`已刷新 ${targets.length - failures.length}/${targets.length} 个连接，部分失败：${failures.join('；')}`);
    }
    setBusy(false);
  }, [load, servers]);

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

  const selectedTools = selected?.tools ?? [];
  const selectedResources = selected?.resources ?? [];
  const selectedPrompts = selected?.prompts ?? [];
  const canSave = transport === 'stdio' ? Boolean(command.trim()) : Boolean(url.trim());

  return (
    <div className={`settings-panel settings-panel--mcp${embedded ? ' settings-panel--embedded' : ''}`}>
      <header className="settings-panel__header mcp-hero">
        <div>
          {!embedded ? (
            <>
              <span className="mcp-eyebrow">Local capability providers</span>
              <h2>MCP 连接</h2>
              <p>管理本地 MCP server。工具先刷新 Manifest，再经 Runtime Projection、PermissionGrant 和 Evidence 链路执行。</p>
            </>
          ) : null}
        </div>
        <div className="mcp-hero__actions">
          <button type="button" onClick={() => setShowAddForm(true)}>
            添加连接
          </button>
          <button type="button" onClick={() => void refreshAll()} disabled={busy}>{busy ? '刷新中…' : '刷新列表'}</button>
        </div>
      </header>

      <section className="mcp-summary-grid" aria-label="MCP summary">
        <article className="mcp-summary-card">
          <span>连接</span>
          <strong>{servers.length}</strong>
          <small>{totals.enabled} enabled</small>
        </article>
        <article className="mcp-summary-card">
          <span>工具</span>
          <strong>{totals.visibleTools}/{totals.tools}</strong>
          <small>visible / discovered</small>
        </article>
        <article className="mcp-summary-card">
          <span>资源</span>
          <strong>{totals.resources}</strong>
          <small>resources</small>
        </article>
        <article className="mcp-summary-card">
          <span>Prompts</span>
          <strong>{totals.prompts}</strong>
          <small>user preview only</small>
        </article>
      </section>

      {status ? <p className="settings-status mcp-status">{status}</p> : null}

      {showAddForm ? (
        <Overlay
          onClose={() => { resetForm(); setShowAddForm(false); }}
          closeOnBackdrop={!busy}
          ariaLabel="新增本地 MCP server"
          panelClassName="mcp-modal-card"
        >
            <header className="mcp-modal-header">
              <div>
                <h3>新增本地 MCP server</h3>
                <p>配置只保存连接元数据；Secret 会单独写入 main 进程凭证库。</p>
              </div>
              <button
                type="button"
                className="mcp-modal-close"
                aria-label="关闭"
                onClick={() => { resetForm(); setShowAddForm(false); }}
                disabled={busy}
              >
                ✕
              </button>
            </header>
            <div className="mcp-modal-body">
            <div className="settings-grid settings-grid--two">
            <label>
              名称
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="filesystem / sentry / internal-tools" />
            </label>
            <div className="settings-grid__wide mcp-field">
              <span className="mcp-field__label">Transport</span>
              <div className="mcp-segment" role="tablist" aria-label="Transport">
                {([
                  { value: 'stdio', label: 'STDIO' },
                  { value: 'streamable_http', label: 'Streamable HTTP' },
                  { value: 'sse', label: 'SSE' },
                ] as const).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={transport === option.value}
                    className={`mcp-segment__btn${transport === option.value ? ' is-active' : ''}`}
                    onClick={() => {
                      setTransport(option.value);
                      setAuthMode('none');
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {transport !== 'stdio' ? (
              <label className="settings-grid__wide">
                Server URL
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:3000/mcp" />
              </label>
            ) : (
              <>
                <label className="settings-grid__wide">
                  Command to launch
                  <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx / uvx / node" />
                </label>
                <div className="settings-grid__wide mcp-field">
                  <span className="mcp-field__label">Arguments</span>
                  {argRows.map((arg, index) => (
                    <div key={`arg-${index}`} className="mcp-row mcp-row--single">
                      <input
                        value={arg}
                        onChange={(event) => updateArgRow(index, event.target.value)}
                        placeholder="-y / @modelcontextprotocol/server-filesystem / /tmp"
                      />
                      <button
                        type="button"
                        className="mcp-row__remove"
                        aria-label="删除参数"
                        onClick={() => removeArgRow(index)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button type="button" className="mcp-row__add" onClick={addArgRow}>
                    + 添加参数
                  </button>
                </div>
                <div className="settings-grid__wide mcp-field">
                  <span className="mcp-field__label">Environment variables</span>
                  {envRows.map((row, index) => (
                    <div key={`env-${index}`} className="mcp-row mcp-row--pair">
                      <input
                        value={row.key}
                        onChange={(event) => updateEnvRow(index, { key: event.target.value })}
                        placeholder="Key"
                      />
                      <input
                        value={row.value}
                        onChange={(event) => updateEnvRow(index, { value: event.target.value })}
                        placeholder="Value"
                      />
                      <button
                        type="button"
                        className="mcp-row__remove"
                        aria-label="删除环境变量"
                        onClick={() => removeEnvRow(index)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button type="button" className="mcp-row__add" onClick={addEnvRow}>
                    + 添加环境变量
                  </button>
                </div>
                <label className="settings-grid__wide">
                  Working directory
                  <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="~/code（可选）" />
                </label>
              </>
            )}
            <label>
              认证方式
              <Dropdown
                value={authMode}
                options={authModeOptions}
                onChange={(value) => setAuthMode(value as McpAuthMode)}
                ariaLabel="认证方式"
              />
            </label>
            {authMode !== 'none' ? (
              <>
                <label>
                  凭证标签
                  <input value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} placeholder="prod token / staging key" />
                </label>
                <label>
                  Secret
                  <input value={credentialSecret} onChange={(event) => setCredentialSecret(event.target.value)} type="password" placeholder="不会保存到 renderer" />
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
            </div>
            <div className="mcp-modal-footer">
              <button type="button" className="mcp-modal-cancel" onClick={() => { resetForm(); setShowAddForm(false); }} disabled={busy}>取消</button>
              <button type="button" className="mcp-modal-confirm" onClick={() => void handleSave()} disabled={busy || !canSave}>保存连接</button>
            </div>
        </Overlay>
      ) : null}

      <div className="mcp-main-grid">
        <aside className="settings-card mcp-sidebar-card">
          <header className="mcp-section-header">
            <div>
              <h3>已配置连接</h3>
              <p>{servers.length ? '选择一个连接查看 Manifest 和治理状态。' : '还没有 MCP 连接。'}</p>
            </div>
          </header>
          {servers.length === 0 ? (
            <div className="mcp-empty-state">
              <strong>还没有 MCP 连接</strong>
              <p>添加一个 streamable HTTP、SSE 或 stdio server 后刷新 Manifest。</p>
              <button type="button" onClick={() => setShowAddForm(true)}>添加连接</button>
            </div>
          ) : (
            <ul className="mcp-server-list">
              {servers.map((server) => {
                const id = serverIdOf(server);
                const active = selected && String(serverIdOf(selected)) === String(id);
                return (
                  <li key={String(id)}>
                    <button type="button" className={active ? 'is-active' : ''} onClick={() => { setSelectedId(id); setResourcePreview(null); setPromptPreview(null); }}>
                      <span>
                        <strong>{labelForServer(server)}</strong>
                        <em>{transportLabel(server.transport)}</em>
                      </span>
                      <small>{server.toolsCount ?? server.tools?.length ?? 0} tools · {server.resourcesCount ?? server.resources?.length ?? 0} resources · {server.promptsCount ?? server.prompts?.length ?? 0} prompts</small>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mcp-credentials-box">
            <header className="mcp-section-header mcp-section-header--compact">
              <div>
                <h3>凭证库</h3>
                <p>只显示非密元数据。</p>
              </div>
            </header>
            {credentials.length === 0 ? (
              <p className="settings-empty">还没有保存 MCP 凭证。</p>
            ) : (
              <ul className="mcp-credential-list">
                {credentials.map((credential) => (
                  <li key={credential.credentialRef}>
                    <button type="button" onClick={() => { void navigator.clipboard?.writeText(credential.credentialRef); setStatus('credentialRef 已复制。'); }}>
                      <span>
                        <strong>{credential.label || credential.credentialRef}</strong>
                        <small>{credential.kind || credential.authMode || 'secret'}{credential.lastFour ? ` · ••••${credential.lastFour}` : ''}</small>
                      </span>
                      <em>{credential.envName ? `env: ${credential.envName}` : credential.headerName || credential.storage || 'local'}</em>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <section className="settings-card mcp-detail-card">
          {selected ? (
            <div className="mcp-server-detail">
              <header className="mcp-detail-header">
                <div>
                  <span className="mcp-eyebrow">Selected server</span>
                  <h3>{labelForServer(selected)}</h3>
                  <p>{endpointForServer(selected)}</p>
                </div>
                <span className={`mcp-health mcp-health--${selected.health?.status ?? (selected.enabled === false ? 'disabled' : 'unknown')}`}>
                  {selected.enabled === false ? 'disabled' : selected.health?.status ?? 'unknown'}
                </span>
              </header>

              {selected.lastError ? <p className="settings-warning">{selected.lastError}</p> : null}

              <dl className="mcp-detail-meta">
                <div>
                  <dt>Transport</dt>
                  <dd>{transportLabel(selected.transport)}</dd>
                </div>
                <div>
                  <dt>Auth</dt>
                  <dd>{authLabel(selected.auth)}</dd>
                </div>
                <div>
                  <dt>Manifest</dt>
                  <dd>{formatDateTime(selected.manifestUpdatedAt)}</dd>
                </div>
                <div>
                  <dt>Tools</dt>
                  <dd>{selected.visibleToolsCount ?? selectedTools.filter((tool) => tool.visible !== false).length}/{selected.toolsCount ?? selectedTools.length} visible</dd>
                </div>
              </dl>

              <div className="settings-actions settings-actions--wrap mcp-detail-actions">
                <button type="button" disabled={busy} onClick={() => void runServerAction('刷新 Manifest', () => clientApi.mcpRefreshManifest({ serverId: serverIdOf(selected) }))}>刷新 Manifest</button>
                <button type="button" disabled={busy} onClick={() => void runServerAction(selected.enabled === false ? '启用连接' : '禁用连接', () => clientApi.mcpSetEnabled({ serverId: serverIdOf(selected), enabled: selected.enabled === false }))}>{selected.enabled === false ? '启用' : '禁用'}</button>
                <button type="button" disabled={busy} onClick={() => void runServerAction('移除连接', () => clientApi.mcpUninstall({ serverId: serverIdOf(selected) }))}>移除</button>
              </div>

              <section className="mcp-manifest-section">
                <header className="mcp-section-header">
                  <div>
                    <h3>Tools</h3>
                    <p>只有 visible 的工具会进入 Runtime Projection。</p>
                  </div>
                </header>
                {selectedTools.length ? (
                  <ul className="mcp-tool-list">
                    {selectedTools.map((tool) => {
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

              <div className="mcp-manifest-grid">
                <section className="mcp-manifest-section">
                  <header className="mcp-section-header">
                    <div>
                      <h3>Resources</h3>
                      <p>读取结果只作为用户可见预览。</p>
                    </div>
                  </header>
                  {selectedResources.length ? (
                    <ul className="mcp-resource-list">
                      {selectedResources.map((resource) => (
                        <li key={resource.uri}>
                          <button type="button" disabled={busy} onClick={() => void handleReadResource(resource.uri)}>{resource.name || resource.uri}</button>
                          <small>{resource.uri}</small>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="settings-empty">尚未发现 resources。</p>}
                  {resourcePreview ? <pre className="mcp-preview">{resourcePreview}</pre> : null}
                </section>

                <section className="mcp-manifest-section">
                  <header className="mcp-section-header">
                    <div>
                      <h3>Prompts</h3>
                      <p>不会自动提升为 system 指令。</p>
                    </div>
                  </header>
                  {selectedPrompts.length ? (
                    <ul className="mcp-resource-list">
                      {selectedPrompts.map((prompt) => (
                        <li key={prompt.name}>
                          <button type="button" disabled={busy} onClick={() => void handleGetPrompt(prompt.name)}>{prompt.name}</button>
                          {prompt.description ? <small>{prompt.description}</small> : null}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="settings-empty">尚未发现 prompts。</p>}
                  {promptPreview ? <pre className="mcp-preview">{promptPreview}</pre> : null}
                </section>
              </div>
            </div>
          ) : (
            <div className="mcp-empty-state mcp-empty-state--detail">
              <strong>选择或添加一个 MCP 连接</strong>
              <p>连接保存后刷新 Manifest，即可在这里管理工具、资源和 prompts。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
