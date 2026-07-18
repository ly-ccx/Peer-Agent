import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';

type ShortcutAction = 'quickChat' | 'newTask';

type ShortcutStatus = {
  configured: string;
  active: string | null;
  registered: boolean;
  error: string | null;
  isDefault: boolean;
};

type ShortcutStatusMap = {
  quickChat: ShortcutStatus;
  newTask: ShortcutStatus;
};

const isMac = navigator.platform.toLowerCase().includes('mac');

const SYMBOL_MODIFIERS = new Set(['⌘', '⌥', '⇧']);

export function displayShortcut(value: string) {
  // Compact badge format for symbol modifiers (⌘K / ⌘⇧N) so sidebar badges
  // match searchChats.shortcut; keep '+' only when text modifiers remain (Ctrl+N).
  const parts = value
    .replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')
    .replace('Command', '⌘')
    .replace('Control', 'Ctrl')
    .replace('Option', '⌥')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .replace('Shift', '⇧')
    .split('+')
    .filter(Boolean);

  if (parts.length === 0) return '';
  const modifiers = parts.slice(0, -1);
  const key = parts[parts.length - 1] ?? '';
  if (modifiers.length > 0 && modifiers.every((part) => SYMBOL_MODIFIERS.has(part))) {
    return `${modifiers.join('')}${key}`;
  }
  return parts.join('+');
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

const ERROR_LABELS: Record<string, string> = {
  'modifier-required': '快捷键必须包含修饰键和一个普通按键。',
  'system-reserved': '此快捷键由系统保留，请选择其他组合。',
  'registration-failed': '此快捷键已被系统或其他应用占用。',
  empty: '请输入有效的快捷键组合。',
};

type ShortcutRowProps = {
  action: ShortcutAction;
  title: string;
  description: string;
  status: ShortcutStatus | null;
  recording: boolean;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onApply: (accelerator: string) => void;
  onReset: () => void;
  showGlobalWarning?: boolean;
};

function ShortcutRow({
  action,
  title,
  description,
  status,
  recording,
  onStartRecording,
  onCancelRecording,
  onApply,
  onReset,
  showGlobalWarning = false,
}: ShortcutRowProps) {
  return (
    <>
      <div className="shortcut-row">
        <div className="shortcut-description">
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <div className="shortcut-controls">
          <button
            type="button"
            className={`shortcut-recorder ${recording ? 'is-recording' : ''}`}
            onClick={onStartRecording}
            onKeyDown={(event) => {
              if (!recording) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === 'Escape') {
                onCancelRecording();
                return;
              }
              const accelerator = acceleratorFromEvent(event);
              if (accelerator) onApply(accelerator);
            }}
            aria-label={`录制${title}的快捷键`}
            data-action={action}
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
          <button
            type="button"
            className="shortcut-reset"
            disabled={status?.isDefault}
            onClick={onReset}
          >
            恢复默认
          </button>
        </div>
      </div>
      {showGlobalWarning && status && !status.registered ? (
        <p className="shortcut-warning">当前快捷键未注册成功，旧快捷键仍然有效。请录制其他组合。</p>
      ) : null}
    </>
  );
}

export function ShortcutsPanel() {
  const [statusMap, setStatusMap] = useState<ShortcutStatusMap | null>(null);
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const [message, setMessage] = useState('');

  const refresh = async () => {
    const result = await clientApi.getShortcutStatus();
    setStatusMap({
      quickChat: result.quickChat,
      newTask: result.newTask,
    });
  };

  useEffect(() => { void refresh(); }, []);

  const apply = async (action: ShortcutAction, accelerator: string) => {
    const result = await clientApi.updateShortcut(action, accelerator);
    if (result.success === false) {
      setMessage(ERROR_LABELS[result.error ?? ''] ?? '无法应用此快捷键。');
    } else {
      setMessage(action === 'newTask' ? '新建任务快捷键已更新。' : '快捷键已更新并立即生效。');
      setStatusMap({
        quickChat: result.quickChat,
        newTask: result.newTask,
      });
    }
    setRecordingAction(null);
    await refresh();
  };

  const reset = async (action: ShortcutAction) => {
    const result = await clientApi.resetShortcut(action);
    if (result.success === false) {
      setMessage('默认快捷键当前不可用。');
    } else {
      setMessage(action === 'newTask' ? '已恢复新建任务默认快捷键。' : '已恢复默认快捷键。');
      setStatusMap({
        quickChat: result.quickChat,
        newTask: result.newTask,
      });
    }
    await refresh();
  };

  return (
    <div className="general-panel shortcuts-panel">
      <header className="settings-panel__header shortcuts-panel__header">
        <div>
          <h2>快捷键</h2>
          <p>自定义全局与应用内快捷键。全局快捷键在后台也可触发。</p>
        </div>
      </header>

      <section className="settings-card shortcut-group" aria-labelledby="app-shortcuts-title">
        <div className="shortcut-group-heading">
          <div>
            <h3 id="app-shortcuts-title">应用内快捷键</h3>
            <p>仅在 Peer Agent 窗口聚焦时生效。</p>
          </div>
        </div>

        <ShortcutRow
          action="newTask"
          title="新建任务"
          description="创建新的任务会话，与侧边栏按钮相同"
          status={statusMap?.newTask ?? null}
          recording={recordingAction === 'newTask'}
          onStartRecording={() => {
            setRecordingAction('newTask');
            setMessage('请按下新的快捷键组合，Esc 取消。');
          }}
          onCancelRecording={() => {
            setRecordingAction(null);
            setMessage('');
          }}
          onApply={(accelerator) => { void apply('newTask', accelerator); }}
          onReset={() => { void reset('newTask'); }}
        />
      </section>

      <section className="settings-card shortcut-group" aria-labelledby="global-shortcuts-title">
        <div className="shortcut-group-heading">
          <div>
            <h3 id="global-shortcuts-title">全局快捷键</h3>
            <p>即使 Peer Agent 在后台，也可以使用这些快捷键。</p>
          </div>
        </div>

        <ShortcutRow
          action="quickChat"
          title="打开快速会话"
          description="在当前界面上方召出 Quick Chat"
          status={statusMap?.quickChat ?? null}
          recording={recordingAction === 'quickChat'}
          onStartRecording={() => {
            setRecordingAction('quickChat');
            setMessage('请按下新的快捷键组合，Esc 取消。');
          }}
          onCancelRecording={() => {
            setRecordingAction(null);
            setMessage('');
          }}
          onApply={(accelerator) => { void apply('quickChat', accelerator); }}
          onReset={() => { void reset('quickChat'); }}
          showGlobalWarning
        />

        <p className="shortcut-feedback" aria-live="polite">{message}</p>
      </section>
    </div>
  );
}
