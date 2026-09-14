import { useEffect, useState, useCallback } from 'react';
import { clientApi } from '../../clientApi';
import type { RemoteAccessPatch } from '../../preload/contracts/bootstrapPreloadApi';
import type { Status } from './remoteAccessPresentation';
import { connectionSummary, describeFailure } from './remoteAccessPresentation';

export function RemoteAccessPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const refresh = useCallback(async () => {
    const r = await clientApi.getRemoteAccess();
    if (r.ok && r.status) setStatus(r.status);
    else setError(r.error ?? 'unknown');
  }, []);

  useEffect(() => {
    refresh();
    // A pairing challenge arrives from the server after the dial succeeds, and it
    // expires. Without polling, a panel opened before the challenge arrived would
    // never show it and the device could not be claimed.
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

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

      {status.pairing && <PairingBlock pairing={status.pairing} gatewayOrigin={s.gatewayOrigin} />}
    </div>
  );
}

/** The handoff to the gateway page. The device is not usable until the user
 * claims it there, so this block has to state what to copy, where to paste it,
 * and how long it stays valid. */
function PairingBlock({ pairing, gatewayOrigin }: {
  pairing: NonNullable<Status['pairing']>;
  gatewayOrigin: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000);
    } catch { setCopied(null); }
  }

  const remaining = pairing.expiresAt - Date.now();
  const expired = remaining <= 0;

  return (
    <div className="general-setting-block" style={{ marginTop: 12, padding: 12, border: '1px solid var(--line, #ddd)', borderRadius: 6 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>待认领：这台设备还没有绑定</p>
      <p className="general-setting-copy" style={{ marginTop: 4 }}>
        打开 <a href={gatewayOrigin || 'https://gw.peer-wo.com'} target="_blank" rel="noreferrer">{gatewayOrigin || 'https://gw.peer-wo.com'}</a>
        ，在「添加设备」里填入下面两项完成绑定。
      </p>

      <div className="general-setting-row">
        <label className="setting-label">挑战 ID</label>
        <code style={{ wordBreak: 'break-all' }}>{pairing.challengeId}</code>
        <button onClick={() => copy('challengeId', pairing.challengeId)} style={{ marginLeft: 8 }}>
          {copied === 'challengeId' ? '已复制' : '复制'}
        </button>
      </div>

      <div className="general-setting-row">
        <label className="setting-label">一次性 Key</label>
        <code style={{ wordBreak: 'break-all' }}>{pairing.pairingKey}</code>
        <button onClick={() => copy('pairingKey', pairing.pairingKey)} style={{ marginLeft: 8 }}>
          {copied === 'pairingKey' ? '已复制' : '复制'}
        </button>
      </div>

      <p className="general-setting-copy" style={{ marginTop: 4 }}>
        {expired
          ? '这次挑战已过期，关闭再打开远程连接可重新获取。'
          : `有效期剩余约 ${Math.max(1, Math.round(remaining / 60000))} 分钟。一次性 Key 请勿转发。`}
      </p>
    </div>
  );
}
