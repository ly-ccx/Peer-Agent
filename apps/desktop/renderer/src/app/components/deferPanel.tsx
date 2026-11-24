import { Component, Suspense, lazy, useEffect, useState, type ComponentType, type ComponentProps, type ReactNode } from 'react';
import { PeerIcon } from '../../ui/icons';
import './deferred-panel.css';

class PanelBoundary extends Component<{ children: ReactNode; retry: () => void; isZh: boolean; renderError?: () => ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('[deferred-panel]', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.renderError) return this.props.renderError();
    return (
      <div className="deferred-panel is-error" role="alert">
        <p>{this.props.isZh ? '此页面暂时无法加载，请重试。' : 'This page could not load. Please retry.'}</p>
        <button type="button" className="ui-button" onClick={this.props.retry}>
          {this.props.isZh ? '重试' : 'Retry'}
        </button>
      </div>
    );
  }
}

function DeferredPanelFallback({ isZh }: { readonly isZh: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 120);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className={`deferred-panel${visible ? ' is-visible' : ''}`} role="status" aria-live="polite">
      {visible ? (
        <span className="deferred-panel-loading">
          <PeerIcon name="loader" size={16} className="deferred-panel-spinner" aria-hidden="true" />
          <span>{isZh ? '正在加载…' : 'Loading…'}</span>
        </span>
      ) : null}
    </div>
  );
}

/** A local loading/retry boundary; caches resolved modules across remounts so revisiting a panel never flashes Loading again. */
export function deferPanel<T extends ComponentType<any>>(load: () => Promise<{ default: T }>, options?: {
  readonly renderError?: (props: ComponentProps<T>, retry: () => void) => ReactNode;
}) {
  type P = ComponentProps<T>;
  let resolved: T | null = null;
  const createLazy = () =>
    lazy(async () => {
      const mod = await load();
      resolved = mod.default;
      return mod;
    });
  let sharedLazy = createLazy();

  return function DeferredPanel(props: P) {
    const [revision, setRevision] = useState(0);
    const locale = 'i18n' in props && props.i18n && typeof props.i18n === 'object' && 'locale' in props.i18n
      ? String(props.i18n.locale)
      : (typeof document !== 'undefined' ? document.documentElement.lang : 'zh-CN');
    const isZh = 'isZh' in props && typeof props.isZh === 'boolean' ? props.isZh : !locale.toLowerCase().startsWith('en');
    const retry = () => {
      resolved = null;
      sharedLazy = createLazy();
      setRevision((current) => current + 1);
    };
    const Content = (resolved ?? sharedLazy) as ComponentType<P>;
    return (
      <PanelBoundary
        key={revision}
        isZh={isZh}
        retry={retry}
        renderError={options?.renderError ? () => options.renderError!(props, retry) : undefined}
      >
        {resolved ? (
          <Content {...props} />
        ) : (
          <Suspense fallback={<DeferredPanelFallback isZh={isZh} />}>
            <Content {...props} />
          </Suspense>
        )}
      </PanelBoundary>
    );
  };
}
