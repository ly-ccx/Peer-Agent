import { useEffect, useState, useCallback } from 'react';
import { clientApi } from '../../clientApi';
import type { RemoteAccessIpcResult, RemoteAccessPatch } from '../../preload/contracts/bootstrapPreloadApi';

type Status = NonNullable<RemoteAccessIpcResult['status']>;

export function RemoteAccessPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const refresh = useCallback(async () => {
    const r = await clientApi.getRemoteAccess();
    if (r.ok && r.status) setStatus(r.status);
    else setError(r.error ?? 'unknown');
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function apply(patch: RemoteAccessPatch) {
    setIsSaving(true);
    setError(null);
    try {
      const r = await clientApi.updateRemoteAccess(patch);
      if (r.ok && r.status) setStatus(r.status);
      else setError(r.error ?? 'update_failed');
    } catch { setError('update_failed'); }
    finally { setIsSaving(false); }
  }

  if (!status) return (
    <div className="general-panel">
      <h3>远程访问</h3>
      <p className="text-muted">正在加载…</p>
    </div>
  );

  const s = status.settings;
  return (
    <div className="general-panel">
      <h3>远程访问</h3>
      <p className="general-setting-copy">
        允许远程网页读取本机任务状态。连接由 macOS 钥匙串持久化，重启不丢失绑定。
      </p>

      {error && <p className="text-warning">错误：{error}</p>}

      <div className="general-setting-row">
        <label className="setting-label">启用远程连接</label>
        <button className="toggle" onClick={() => apply({ enabled: !s.enabled })} disabled={isSaving}>
          {s.enabled ? '已开启' : '已关闭'}
        </button>
      </div>

      <div className="general-setting-row">
        <label className="setting-label">Gateway 地址</label>
        <input
          type="text" defaultValue={s.gatewayOrigin}
          placeholder="https://gw.peer-wo.com" disabled={isSaving}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.gatewayOrigin) apply({ gatewayOrigin: v }); }}
          style={{ width: 360 }}
        />
      </div>

      <div className="general-setting-row">
        <label className="setting-label">工作区 ID</label>
        <input
          type="text" defaultValue={s.workspaceId}
          placeholder="default" disabled={isSaving}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.workspaceId) apply({ workspaceId: v }); }}
          style={{ width: 200 }}
        />
      </div>

      <div className="general-setting-row">
        <label className="setting-label">连接状态</label>
        <span>{connectionSummary(status)}</span>
        {status.deviceId && <code style={{ marginLeft: 8 }}>{status.deviceId}</code>}
      </div>

      {!status.online && status.lastFailure && (
        <p className="text-warning" style={{ marginTop: 4 }}>
          连接失败：{describeFailure(status.lastFailure)}
        </p>
      )}
    </div>
  );
}

/** One line for the status row. A failure is reported as a failure, never as a
 * pending connection: "connecting…" for a dial that already gave up hides the
 * only information the user needs to fix it. */
function connectionSummary(status: Status): string {
  if (status.online) return `已连接${status.deviceId ? ` (${status.deviceId})` : ''}`;
  if (status.lastFailure) return '连接失败';
  return status.active ? '正在连接…' : '未连接';
}

const FAILURE_HINTS: Record<string, string> = {
  SELF_SIGNED_CERT_IN_CHAIN: '证书链不受信任。若网络中有 TLS 代理，请把它的根证书加入系统信任，或让 Node 读取系统根证书。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务器证书，可能被中间代理替换。',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器使用了自签证书。',
  CERT_HAS_EXPIRED: '服务器证书已过期。',
  ENOTFOUND: '域名解析失败。请检查 Gateway 地址拼写与网络。',
  ECONNREFUSED: '服务器拒绝连接。请确认 Gateway 正在运行、端口可达。',
  ETIMEDOUT: '连接超时。请检查网络或防火墙。',
};

/** Turn a structured failure into something a person can act on. */
function describeFailure(failure: NonNullable<Status['lastFailure']>): string {
  const hint = failure.code ? FAILURE_HINTS[failure.code] : undefined;
  const code = failure.code ? `[${failure.code}] ` : '';
  if (hint) return `${code}${hint}`;
  if (failure.message) return `${code}${failure.message}`;
  return `${code}${failure.reason}`;
}