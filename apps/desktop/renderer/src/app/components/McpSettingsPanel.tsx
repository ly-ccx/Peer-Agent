import type { LocalMcpServerUpsertRequest, McpConnectionProbeResult } from '@peer-agent/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import { useConfirm } from './ConfirmProvider';
import { Drawer } from './Drawer';
import { Dropdown, type DropdownOption } from './Dropdown';
import { Overlay } from './Overlay';

type McpTransportKind = 'streamable_http' | 'sse' | 'stdio';
type McpAuthMode = 'none' | 'http_bearer' | 'http_header' | 'stdio_env' | 'oauth2';

// 回调地址由应用固定（与 main 进程 DEFAULT_OAUTH_REDIRECT_URL 保持一致），
// 仅作展示/复制用途，不再让用户手填。
const OAUTH_REDIRECT_URL = 'http://127.0.0.1:33418/mcp/oauth/callback';

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

type McpOAuthConfigView = {
  readonly authorizationServerUrl?: string;
  readonly clientId?: string;
  readonly clientSecretConfigured?: boolean;
  readonly scopes?: readonly string[];
  readonly redirectUrl?: string;
  readonly tokenStatus?: 'missing' | 'available';
  readonly expiresAt?: string;
};

type McpCredentialView = {
  readonly credentialRef: string;
  readonly label?: string;
  readonly kind?: string;
  readonly authMode?: string;
  readonly headerName?: string;
  readonly envName?: string;
  readonly oauth?: McpOAuthConfigView;
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
  readonly auth?: { readonly mode?: McpAuthMode; readonly credentialRef?: string; readonly headerName?: string; readonly envName?: string; readonly oauth?: McpOAuthConfigView };
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
  if (auth.mode === 'oauth2') return `OAuth 2.0${auth.oauth?.tokenStatus === 'available' ? ' · 已登录' : ' · 需要登录'}`;
  return auth.mode;
}

// Heuristic: does an error message look like an unauthorized / needs-auth failure?
// Used so the auth guidance button can be derived from persisted health/lastError,
// not only from the transient in-session probe result.
function isAuthRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = String(message).toLowerCase();
  return (
    text.includes('401')
    || text.includes('403')
    || text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('www-authenticate')
    || text.includes('needs_auth')
    || text.includes('需要身份验证')
    || text.includes('缺少有效的身份凭证')
    || text.includes('身份凭证')
    || text.includes('未授权')
  );
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
  const confirm = useConfirm();
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
  const [oauthAuthorizationServerUrl, setOauthAuthorizationServerUrl] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [oauthScopes, setOauthScopes] = useState('');
  const oauthRedirectUrl = OAUTH_REDIRECT_URL;
  const [oauthAuthorizationCode, setOauthAuthorizationCode] = useState('');
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [resourcePreview, setResourcePreview] = useState<string | null>(null);
  const [promptPreview, setPromptPreview] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [lastProbe, setLastProbe] = useState<McpConnectionProbeResult | null>(null);

  const load = useCallback(async () => {
    const [list, credentialList] = await Promise.all([
      clientApi.mcpListInstalled() as Promise<readonly McpServerView[]>,
      clientApi.mcpListCredentials() as Promise<readonly McpCredentialView[]>,
    ]);
    setServers(list);
    setCredentials(credentialList);
    // 不自动选中任何 server：Drawer 只由用户点击卡片打开，避免进入 MCP tab 时自动弹出。
    onServersCountChange?.(list.length);
  }, [onServersCountChange]);

  useEffect(() => { void load(); }, [load]);

  const handleDeleteCredential = useCallback(async (credentialRef: string, label?: string) => {
    if (!credentialRef) return;
    const ok = await confirm({
      title: '删除凭证',
      message: `确认删除凭证「${label || credentialRef}」？此操作不可撤销。`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setStatus('正在删除凭证…');
    try {
      await clientApi.mcpDeleteCredential({ credentialRef });
      await load();
      setStatus('凭证已删除。');
    } catch (error) {
      setStatus(`删除凭证失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [confirm, load]);

  useEffect(() => {
    if (transport === 'stdio' && (authMode === 'http_bearer' || authMode === 'http_header' || authMode === 'oauth2')) setAuthMode('none');
    if (transport !== 'stdio' && authMode === 'stdio_env') setAuthMode('none');
  }, [authMode, transport]);

  const authModeOptions = useMemo<DropdownOption[]>(() => {
    const options: DropdownOption[] = [{ value: 'none', label: '无认证' }];
    if (transport !== 'stdio') {
      options.push({ value: 'http_bearer', label: 'HTTP Bearer token' });
      options.push({ value: 'http_header', label: 'HTTP custom header' });
      options.push({ value: 'oauth2', label: 'OAuth 2.0' });
    } else {
      options.push({ value: 'stdio_env', label: 'stdio env secret' });
    }
    return options;
  }, [transport]);

  const selected = useMemo(
    () => (selectedId == null ? null : servers.find((server) => String(serverIdOf(server)) === String(selectedId)) ?? null),
    [selectedId, servers],
  );
  const selectedProbeNeedsAuth = Boolean(
    selected
      && lastProbe?.state === 'needs_auth'
      && lastProbe.view
      && String(serverIdOf(lastProbe.view as McpServerView)) === String(serverIdOf(selected)),
  );
  // Derive "needs auth" from persisted health/lastError too, so the guidance
  // button stays visible after reload/reselect (when the transient lastProbe is
  // gone) whenever the server last failed with an unauthorized-style error.
  const selectedPersistedNeedsAuth = Boolean(
    selected
      && selected.health?.status === 'failed'
      && isAuthRequiredMessage(selected.lastError),
  );
  const selectedNeedsAuth = selectedProbeNeedsAuth || selectedPersistedNeedsAuth;

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
    setOauthAuthorizationServerUrl('');
    setOauthClientId('');
    setOauthClientSecret('');
    setOauthScopes('');
    setOauthAuthorizationCode('');
    setShowAdvancedSettings(false);
    setLastProbe(null);
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
        if (authMode === 'oauth2') {
          const scopes = oauthScopes.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean);
          // 按 label 兜底复用已有 oauth 凭证：避免移除后重新添加同名 server 时
          // 又新建一条重复凭证（历史遗留孤儿的防御路径）。
          const reuseLabel = credentialLabel.trim() || displayName.trim();
          const existing = reuseLabel
            ? credentials.find((c) => (c.kind === 'oauth2' || c.authMode === 'oauth2') && c.label === reuseLabel)
            : undefined;
          const credential = await clientApi.mcpPutCredential({
            ...(existing ? { credentialRef: existing.credentialRef } : {}),
            label: credentialLabel.trim() || displayName.trim() || undefined,
            kind: 'oauth2',
            oauth: {
              // 授权服务器地址通常留空：后端会按 MCP Authorization 规范自动发现
              // （.well-known + 动态注册）。仅在自动发现失败时才由用户手填。
              authorizationServerUrl: oauthAuthorizationServerUrl.trim() || undefined,
              clientId: oauthClientId.trim() || undefined,
              clientSecret: oauthClientSecret || undefined,
              scopes,
              // 回调地址由应用固定、后端有默认常量兜底，不再从可编辑输入透传。
            },
          });
          auth = {
            mode: 'oauth2',
            credentialRef: credential.credentialRef,
            oauth: credential.oauth,
          };
        } else {
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
      let saved: McpServerView;
      if (transport === 'streamable_http' && authMode === 'none' && !showAdvancedSettings) {
        const probe = await clientApi.mcpConnectAndRegister({
          serverName: item.displayName ?? (displayName.trim() || url.trim()),
          serverUrl: url.trim(),
        });
        setLastProbe(probe);
        saved = (probe.view ?? await clientApi.mcpUpsertServer(item)) as McpServerView;
        if (probe.state === 'connected') {
          setStatus(`MCP 已连接，发现 ${probe.toolsCount} 个工具、${probe.resourcesCount} 个资源、${probe.promptsCount} 个 Prompt。`);
        } else if (probe.state === 'needs_auth') {
          // 探测到需 OAuth：自动切换认证方式为 OAuth 2.0 并展开高级设置，
          // 用户无需再手动去高级设置里改认证方式，再点“登录授权”即可。
          setAuthMode('oauth2');
          setShowAdvancedSettings(true);
          setStatus('已检测到需 OAuth，已自动切换为 OAuth 2.0，请点击“登录授权”完成登录。');
        } else {
          setStatus(probe.message ?? 'MCP 连接失败，请检查 URL 或展开高级设置。');
        }
      } else {
        saved = await clientApi.mcpUpsertServer(item) as McpServerView;
        setLastProbe(null);
        setStatus('MCP 连接已保存。请刷新 Manifest 后再让模型使用工具。');
      }
      resetForm();
      setShowAddForm(false);
      await load();
      setSelectedId(serverIdOf(saved as McpServerView));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存 MCP 连接失败');
    } finally {
      setBusy(false);
    }
  }, [argRows, authEnvName, authHeaderName, authMode, command, credentialLabel, credentialSecret, cwd, displayName, envRows, load, oauthAuthorizationServerUrl, oauthClientId, oauthClientSecret, oauthRedirectUrl, oauthScopes, resetForm, showAdvancedSettings, transport, url]);

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

  const handleFinishOAuth = useCallback(async (server: McpServerView) => {
    const code = oauthAuthorizationCode.trim();
    if (!code) {
      setStatus('请先粘贴 OAuth authorization code。');
      return;
    }
    await runServerAction('完成 OAuth 授权', async () => {
      await clientApi.mcpFinishOAuth({ serverId: serverIdOf(server), authorizationCode: code });
      setOauthAuthorizationCode('');
    });
  }, [oauthAuthorizationCode, runServerAction]);

  // 已保存但探测到需认证的服务器：一键将其认证方式提升为 OAuth 2.0。
  // 授权服务器地址留空交后端自动发现；提升后展示“登录授权”按钮，
  // 由用户再点一次完成登录（保留确认步骤）。
  const handlePromoteToOAuth = useCallback(async (server: McpServerView) => {
    setBusy(true);
    setStatus('正在切换为 OAuth 2.0…');
    try {
      // 复用 server 已绑定的 credentialRef，避免每次点击都新建一条孤儿 oauth 凭证。
      const existingRef = server.auth?.credentialRef;
      const credential = await clientApi.mcpPutCredential({
        ...(existingRef ? { credentialRef: existingRef } : {}),
        label: labelForServer(server),
        kind: 'oauth2',
        oauth: { scopes: [] },
      });
      await clientApi.mcpUpsertServer({
        id: String(serverIdOf(server)),
        transport: server.transport ?? 'streamable_http',
        auth: { mode: 'oauth2', credentialRef: credential.credentialRef, oauth: credential.oauth },
      });
      await load();
      setStatus('已切换为 OAuth 2.0，请点击“登录授权”完成登录。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '切换为 OAuth 2.0 失败');
    } finally {
      setBusy(false);
    }
  }, [load]);

  const handleStartOAuth = useCallback(async (server: McpServerView) => {
    setBusy(true);
    setStatus('正在打开浏览器进行 OAuth 授权，请在浏览器中完成登录…');
    try {
      await clientApi.mcpStartOAuth({ serverId: serverIdOf(server) });
      setOauthAuthorizationCode('');
      await load();
      setStatus('OAuth 授权完成，已刷新连接状态。');
    } catch (error) {
      // 把后端归一化错误码翻译成用户可读提示，避免再退化成“无认证”。
      const raw = error instanceof Error ? error.message : String(error);
      const message = raw.includes('MCP_OAUTH_NOT_CONFIGURED')
        ? '该服务未配置 OAuth 凭据，请先在高级设置中填写授权服务器 / Client 信息。'
        : raw.includes('MCP_OAUTH_UNSUPPORTED_TRANSPORT')
          ? '当前仅支持 HTTP / Streamable HTTP 类型的 MCP 进行 OAuth 登录。'
          : raw.includes('MCP_OAUTH_DISCOVERY_FAILED')
            ? '无法按 MCP 授权规范发现授权服务器（服务端可能未提供元数据或不支持动态注册），请改用手动粘贴 code 方式或联系服务方。'
            : raw.includes('MCP_OAUTH_NO_BROWSER')
              ? '无法打开系统浏览器完成授权。'
              : raw.includes('timed out')
                ? 'OAuth 授权超时，请重试。'
                : raw;
      setStatus(`OAuth 授权失败：${message}`);
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
            {transport !== 'stdio' ? (
              <label>
                URL
                <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" />
              </label>
            ) : null}
            <div className="settings-grid__wide mcp-field">
              <button
                type="button"
                className="mcp-row__add"
                onClick={() => setShowAdvancedSettings((value) => !value)}
              >
                {showAdvancedSettings ? '收起高级设置' : '高级设置'}
              </button>
              <small>默认使用 Streamable HTTP；保存时会自动检测连接与认证状态。</small>
            </div>
            {showAdvancedSettings ? (
            <>
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
                {authMode === 'oauth2' ? (
                  <>
                    <label className="settings-grid__wide">
                      Authorization Server URL（可选）
                      <input value={oauthAuthorizationServerUrl} onChange={(event) => setOauthAuthorizationServerUrl(event.target.value)} placeholder="通常留空自动发现，仅自动发现失败时手动填" />
                    </label>
                    <label>
                      Client ID
                      <input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} placeholder="可选；留空则尝试动态注册" />
                    </label>
                    <label>
                      Client Secret
                      <input value={oauthClientSecret} onChange={(event) => setOauthClientSecret(event.target.value)} type="password" placeholder="可选；不会保存到 renderer" />
                    </label>
                    <label>
                      Scopes
                      <input value={oauthScopes} onChange={(event) => setOauthScopes(event.target.value)} placeholder="以空格或逗号分隔" />
                    </label>
                    <label className="settings-grid__wide">
                      回调地址（应用固定，如认证服务器要求登记请复制加白名单）
                      <div className="settings-readonly-field">
                        <input value={oauthRedirectUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard?.writeText(oauthRedirectUrl).then(() => setStatus('已复制回调地址。'))}
                        >
                          复制
                        </button>
                      </div>
                    </label>
                  </>
                ) : (
                  <>
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
                )}
              </>
            ) : null}
            </>
            ) : null}
            </div>
            <p className="settings-muted">默认保存会立即连接并检测认证状态；认证 Secret 只通过 IPC 送入 main 进程凭证库，renderer 不保存密钥。</p>
            </div>
            <div className="mcp-modal-footer">
              <button type="button" className="mcp-modal-cancel" onClick={() => { resetForm(); setShowAddForm(false); }} disabled={busy}>取消</button>
              <button type="button" className="mcp-modal-confirm" onClick={() => void handleSave()} disabled={busy || !canSave}>{showAdvancedSettings ? '保存连接' : '连接'}</button>
            </div>
        </Overlay>
      ) : null}

      <div className="mcp-grid-wrap">
        {servers.length === 0 ? (
          <div className="mcp-empty-state">
            <strong>还没有 MCP 连接</strong>
            <p>点击右上角「添加连接」保存 server 后刷新 Manifest。</p>
          </div>
        ) : (
          <div className="skill-grid mcp-card-grid">
            {servers.map((server) => {
              const id = serverIdOf(server);
              const failed = server.enabled !== false && (server.health?.status === 'error' || Boolean(server.lastError));
              return (
                <div
                  key={String(id)}
                  className={`skill-card mcp-card${server.enabled === false ? ' disabled' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelectedId(id); setResourcePreview(null); setPromptPreview(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(id); setResourcePreview(null); setPromptPreview(null); } }}
                >
                  <span className="skill-avatar" aria-hidden="true">{labelForServer(server).charAt(0).toUpperCase()}</span>
                  <div className="skill-card-body">
                    <div className="skill-card-title-row">
                      <strong className="skill-card-name">{labelForServer(server)}</strong>
                      <span className="skill-card-actions">
                        {failed ? <span className="mcp-card-badge">FAILED</span> : null}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={server.enabled !== false}
                          className={`skill-toggle ${server.enabled !== false ? 'on' : 'off'}`}
                          disabled={busy}
                          onClick={(e) => { e.stopPropagation(); void runServerAction(server.enabled === false ? '启用连接' : '禁用连接', () => clientApi.mcpSetEnabled({ serverId: serverIdOf(server), enabled: server.enabled === false })); }}
                        >
                          <span className="skill-toggle-thumb" />
                        </button>
                      </span>
                    </div>
                    <span className="skill-card-desc">{endpointForServer(server)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected ? (
        <Drawer
          onClose={() => setSelectedId(null)}
          ariaLabel={`MCP 详情：${labelForServer(selected)}`}
          panelClassName="mcp-drawer"
        >
          <div className="mcp-drawer-body">
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
                  <dd>
                    {selected.auth?.mode === 'oauth2'
                      ? authLabel(selected.auth)
                      : selectedNeedsAuth
                        ? '需要认证（请配置 OAuth）'
                        : authLabel(selected.auth)}
                  </dd>
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
                {selected.auth?.mode === 'oauth2' ? (
                  <button type="button" disabled={busy} onClick={() => void handleStartOAuth(selected)}>
                    {selected.auth?.oauth?.tokenStatus === 'available' ? '重新认证' : '登录授权'}
                  </button>
                ) : selectedNeedsAuth ? (
                  <button type="button" disabled={busy} onClick={() => void handlePromoteToOAuth(selected)}>进行身份验证</button>
                ) : null}
                <button type="button" disabled={busy} onClick={() => void runServerAction(selected.enabled === false ? '启用连接' : '禁用连接', () => clientApi.mcpSetEnabled({ serverId: serverIdOf(selected), enabled: selected.enabled === false }))}>{selected.enabled === false ? '启用' : '禁用'}</button>
                <button type="button" disabled={busy} onClick={() => void runServerAction('移除连接', () => clientApi.mcpUninstall({ serverId: serverIdOf(selected) }))}>移除</button>
              </div>

              {selected.auth?.mode === 'oauth2' ? (
                <div className="settings-inline-form mcp-oauth-finish">
                  <p className="settings-help">推荐直接点击上方“{selected.auth?.oauth?.tokenStatus === 'available' ? '重新认证' : '登录授权'}”：会自动打开浏览器并完成回调换取 token，无需手动粘贴。access token 只会写入 main 进程凭证库。</p>
                  <label>
                    手动粘贴 authorization code（备用）
                    <input value={oauthAuthorizationCode} onChange={(event) => setOauthAuthorizationCode(event.target.value)} placeholder="若自动回调不可用，浏览器授权后粘贴 code" />
                  </label>
                  <button type="button" disabled={busy || !oauthAuthorizationCode.trim()} onClick={() => void handleFinishOAuth(selected)}>完成 OAuth 授权</button>
                </div>
              ) : null}

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

              {(() => {
                const bound = credentials.filter((c) => (
                  selected.auth?.credentialRef
                    ? c.credentialRef === selected.auth.credentialRef
                    : (c.label && c.label === labelForServer(selected))
                ));
                if (bound.length === 0) return null;
                return (
                  <section className="mcp-manifest-section mcp-drawer-credentials">
                    <header className="mcp-section-header">
                      <div>
                        <h3>凭证</h3>
                        <p>该连接绑定的凭证，只显示非密元数据。</p>
                      </div>
                    </header>
                    <ul className="mcp-credential-list">
                      {bound.map((credential) => (
                        <li key={credential.credentialRef} className="mcp-credential-item">
                          <span className="mcp-credential-meta">
                            <strong>{credential.label || credential.credentialRef}</strong>
                            <small>{credential.kind || credential.authMode || 'secret'}{credential.lastFour ? ` · ••••${credential.lastFour}` : ''}{credential.oauth ? ` · ${credential.oauth.tokenStatus === 'available' ? 'OAuth 已登录' : 'OAuth 未登录'}` : ''}</small>
                          </span>
                          <button
                            type="button"
                            className="mcp-credential-delete"
                            disabled={busy}
                            title="删除该凭证"
                            onClick={() => { void handleDeleteCredential(credential.credentialRef, credential.label); }}
                          >
                            删除
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })()}

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
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
