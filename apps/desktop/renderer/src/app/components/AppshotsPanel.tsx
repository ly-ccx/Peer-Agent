import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { displayShortcut } from './ShortcutsPanel';

type PermissionState = {
  ok: boolean;
  status: string;
  canCapture: boolean;
};

type CaptureFeedback =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; conversationId: string; created: boolean }
  | { kind: 'error'; code: string };

/**
 * Appshots 设置分区（P0a 最小版，产品文档 §6.4）：
 * 总开关 / 热键状态（当前无全局热键，双 ⌘ 暂缓）/ Screen Recording 权限状态 / 测试捕获。
 * 权限真值在主进程（ADR 59）；这里只表达状态，不做本地权限判断。
 */
export function AppshotsPanel() {
  const isZh = navigator.language.toLowerCase().startsWith('zh');
  const [enabled, setEnabled] = useState<boolean>(() => {
    const settings = clientApi.initialSettings as { appshots?: { enabled?: boolean } };
    return settings.appshots?.enabled !== false;
  });
  const [hotkey, setHotkey] = useState<string>('');
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [feedback, setFeedback] = useState<CaptureFeedback>({ kind: 'idle' });

  const refresh = async () => {
    try {
      const [shortcuts, perm] = await Promise.all([
        clientApi.getShortcutStatus(),
        clientApi.appshotPermissionStatus(),
      ]);
      setHotkey(shortcuts.appshot?.configured ?? '');
      setPermission({ ok: perm.ok, status: perm.status, canCapture: perm.canCapture });
    } catch {
      setPermission(null);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    await clientApi.updateSettings({ appshots: { enabled: next } });
  };

  const testCapture = async () => {
    setFeedback({ kind: 'busy' });
    try {
      const result = await clientApi.appshotCapture();
      if (result.ok && result.delivery) {
        setFeedback({ kind: 'ok', conversationId: result.delivery.conversationId, created: result.delivery.created });
      } else {
        setFeedback({ kind: 'error', code: result.code ?? 'unknown' });
      }
    } catch {
      setFeedback({ kind: 'error', code: 'ipc_failed' });
    }
    await refresh();
  };

  const errorLabel = (code: string) => {
    switch (code) {
      case 'permission_denied':
        return isZh ? '缺少屏幕录制权限，已尝试打开系统设置。' : 'Screen Recording permission missing; opened System Settings.';
      case 'peer_frontmost':
        return isZh ? 'Peer 自身在前台，请先切换到要捕获的应用。' : 'Peer is frontmost. Switch to the app you want to capture first.';
      case 'no_window':
        return isZh ? '未找到可捕获的前台窗口。' : 'No capturable frontmost window found.';
      case 'window_not_capturable':
        return isZh ? '该窗口不支持捕获（部分系统窗口受保护）。' : 'This window cannot be captured (some system windows are protected).';
      case 'disabled':
        return isZh ? 'Appshots 已停用，请先打开总开关。' : 'Appshots is disabled. Turn it on first.';
      default:
        return isZh ? `捕获失败（${code}）。` : `Capture failed (${code}).`;
    }
  };

  return (
    <div className="general-panel appshots-panel">
      <header className="settings-panel__header">
        <div>
          <h2>Appshots</h2>
          <p>
            {isZh
              ? '按下热键，把当前前台应用窗口的画面发送到 Peer 会话。文本提取能力将在后续版本加入。'
              : 'Press the hotkey to send a snapshot of your frontmost app window into a Peer conversation. Text extraction arrives in a later phase.'}
          </p>
        </div>
      </header>

      <section className="settings-card">
        <label className="settings-row">
          <span>
            <strong>{isZh ? '启用 Appshots' : 'Enable Appshots'}</strong>
            <small>{isZh ? '关闭后热键与测试捕获均不工作。' : 'When off, the hotkey and test capture do nothing.'}</small>
          </span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => { void toggleEnabled(event.target.checked); }}
          />
        </label>

        <div className="settings-row">
          <span>
            <strong>{isZh ? '捕获热键' : 'Capture hotkey'}</strong>
            <small>
              {isZh
                ? '全局热键暂未启用（目标为左右 ⌘ 同按，待开发者账号就绪后再做）。当前请用下方「测试捕获」。'
                : 'No global hotkey for now (target is left+right ⌘; deferred until developer signing). Use Test capture below.'}
            </small>
          </span>
          <kbd>{hotkey ? displayShortcut(hotkey) : (isZh ? '未绑定' : 'Unbound')}</kbd>
        </div>

        <div className="settings-row">
          <span>
            <strong>{isZh ? '屏幕录制权限' : 'Screen Recording permission'}</strong>
            <small>
              {permission == null
                ? (isZh ? '状态未知' : 'Status unknown')
                : permission.canCapture
                  ? (isZh ? '已授权' : 'Granted')
                  : (isZh ? `未授权（${permission.status}）` : `Not granted (${permission.status})`)}
            </small>
          </span>
          {permission != null && !permission.canCapture ? (
            <button type="button" onClick={() => { void clientApi.appshotOpenScreenSettings(); }}>
              {isZh ? '打开系统设置' : 'Open System Settings'}
            </button>
          ) : null}
        </div>

        <div className="settings-row">
          <span>
            <strong>{isZh ? '测试捕获' : 'Test capture'}</strong>
            <small>{isZh ? '立即捕获当前前台窗口（Peer 自身在前台时会提示切换）。' : 'Capture the frontmost window now (switching away from Peer is required).'}</small>
          </span>
          <button type="button" disabled={feedback.kind === 'busy' || !enabled} onClick={() => { void testCapture(); }}>
            {feedback.kind === 'busy' ? (isZh ? '捕获中…' : 'Capturing…') : (isZh ? '测试捕获' : 'Test capture')}
          </button>
        </div>

        <p className="shortcut-feedback" aria-live="polite">
          {feedback.kind === 'ok'
            ? (isZh
              ? `已投递到会话${feedback.created ? '（新建）' : ''}。`
              : `Delivered to a conversation${feedback.created ? ' (newly created)' : ''}.`)
            : feedback.kind === 'error'
              ? errorLabel(feedback.code)
              : ''}
        </p>
      </section>
    </div>
  );
}
