import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

type ShortcutStatus = {
  configured: string;
  active: string | null;
  registered: boolean;
  error: string | null;
  isDefault: boolean;
};

const isMac = navigator.platform.toLowerCase().includes('mac');

function displayShortcut(value: string) {
  return value
    .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', 'Ctrl')
    .replace('Option', '⌥')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .replace('Shift', '⇧')
    .split('+')
    .join(' ');
}

function acceleratorFromEvent(event: React.KeyboardEvent) {
  const key = event.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return '';
  const parts: string[] = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (parts.length === 0) return '';
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key === ' ' ? 'Space' : key;
  parts.push(normalizedKey);
  return parts.join('+');
}

export function ShortcutsPanel() {
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    const result = await clientApi.getShortcutStatus();
    setStatus(result.quickChat);
  };

  useEffect(() => { void refresh(); }, []);

  const apply = async (accelerator: string) => {
    const result = await clientApi.updateShortcut(accelerator);
    if (!result.success) {
      const labels: Record<string, string> = {
        'modifier-required': '快捷键必须包含修饰键和一个普通按键。',
        'system-reserved': '此快捷键由系统保留，请选择其他组合。',
        'registration-failed': '此快捷键已被系统或其他应用占用。',
      };
      setMessage(labels[result.error ?? ''] ?? '无法应用此快捷键。');
    } else {
      setMessage('快捷键已更新并立即生效。');
    }
    setRecording(false);
    await refresh();
  };

  return (
    <div className="general-panel shortcuts-panel">
      <header className="settings-panel__header shortcuts-panel__header">
        <div>
          <h2>快捷键</h2>
          <p>自定义 Peer Agent 的全局快捷操作。</p>
        </div>
      </header>

      <section className="settings-card shortcut-group" aria-labelledby="global-shortcuts-title">
        <div className="shortcut-group-heading">
          <div>
            <h3 id="global-shortcuts-title">全局快捷键</h3>
            <p>即使 Peer Agent 在后台，也可以使用这些快捷键。</p>
          </div>
        </div>

        <div className="shortcut-row">
          <div className="shortcut-description">
            <strong>打开快速会话</strong>
            <span>在当前界面上方召出 Quick Chat</span>
          </div>
          <div className="shortcut-controls">
            <button
              type="button"
              className={`shortcut-recorder ${recording ? 'is-recording' : ''}`}
              onClick={() => { setRecording(true); setMessage('请按下新的快捷键组合，Esc 取消。'); }}
              onKeyDown={(event) => {
                if (!recording) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === 'Escape') { setRecording(false); setMessage(''); return; }
                const accelerator = acceleratorFromEvent(event);
                if (accelerator) void apply(accelerator);
              }}
              aria-label="录制打开快速会话的快捷键"
            >
              {recording ? (
                <span className="shortcut-recorder__prompt">按下快捷键…</span>
              ) : status ? (
                <kbd>{displayShortcut(status.configured)}</kbd>
              ) : (
                <span className="shortcut-recorder__prompt">加载中…</span>
              )}
            </button>
            <span className={`shortcut-state ${status?.registered ? 'is-ok' : 'is-error'}`}>
              <span className="shortcut-state__dot" aria-hidden="true" />
              {status?.registered ? '可用' : '冲突'}
            </span>
            <button type="button" className="shortcut-reset" disabled={status?.isDefault} onClick={async () => {
              const result = await clientApi.resetShortcut();
              setMessage(result.success ? '已恢复默认快捷键。' : '默认快捷键当前不可用。');
              await refresh();
            }}>恢复默认</button>
          </div>
        </div>

        {!status?.registered && status ? <p className="shortcut-warning">当前快捷键未注册成功，旧快捷键仍然有效。请录制其他组合。</p> : null}
        <p className="shortcut-feedback" aria-live="polite">{message}</p>
      </section>
    </div>
  );
}
