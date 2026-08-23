import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  readonly children: ReactNode;
  readonly isZh?: boolean;
};

type State = {
  readonly error: Error | null;
};

/**
 * 根级错误边界：避免任意渲染异常导致整窗永久白屏。
 * 启动权限门 / 主题 / bootstrap 任一抛错时至少给出可恢复 UI。
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const isZh = this.props.isZh !== false;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'var(--za-app-bg, #F4F6F9)',
          color: 'var(--graphite-base, #1a1d21)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ maxWidth: 520, display: 'grid', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>{isZh ? '界面渲染失败' : 'UI render failed'}</h1>
          <p style={{ margin: 0, lineHeight: 1.5, opacity: 0.8 }}>
            {isZh
              ? '应用启动时发生错误。可尝试重新加载；若持续白屏，请完全退出后重启 Peer Agent。'
              : 'The app failed while rendering. Try reloading; if it stays blank, fully quit and relaunch Peer Agent.'}
          </p>
          <pre
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 12,
              background: 'rgba(0,0,0,0.06)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 12,
            }}
          >
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              justifySelf: 'start',
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid var(--graphite-base, #1A1D21)',
              background: 'var(--graphite-base, #1A1D21)',
              color: 'var(--za-accent-ink, #F7F9FC)',
              cursor: 'pointer',
            }}
          >
            {isZh ? '重新加载' : 'Reload'}
          </button>
        </div>
      </div>
    );
  }
}
