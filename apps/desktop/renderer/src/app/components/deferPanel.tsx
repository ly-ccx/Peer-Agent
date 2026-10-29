import { Component, Suspense, lazy, useState, type ComponentType, type ComponentProps, type ReactNode } from 'react';
import './deferred-panel.css';

class PanelBoundary extends Component<{ children: ReactNode; retry: () => void; isZh: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('[deferred-panel]', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="deferred-panel" role="alert">
      <p>{this.props.isZh ? '此页面暂时无法加载，请重试。' : 'This page could not load. Please retry.'}</p>
      <button type="button" onClick={this.props.retry}>{this.props.isZh ? '重试' : 'Retry'}</button>
    </div>;
  }
}

/** A local loading/retry boundary; an optional feature never suspends the application shell. */
export function deferPanel<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  type P = ComponentProps<T>;
  return function DeferredPanel(props: P) {
    const [content, setContent] = useState(() => ({ Component: lazy(load), revision: 0 }));
    const locale = 'i18n' in props && props.i18n && typeof props.i18n === 'object' && 'locale' in props.i18n
      ? String(props.i18n.locale) : document.documentElement.lang;
    const isZh = !locale.toLowerCase().startsWith('en');
    const Content = content.Component as ComponentType<P>;
    return <PanelBoundary key={content.revision} isZh={isZh}
      retry={() => setContent(current => ({ Component: lazy(load), revision: current.revision + 1 }))}>
      <Suspense fallback={<div className="deferred-panel" role="status">{isZh ? '正在加载…' : 'Loading…'}</div>}>
        <Content {...props} />
      </Suspense>
    </PanelBoundary>;
  };
}
