import { browserFeedbackNoticeText } from './feedback/browserFeedbackNotice';
import type { BrowserResourceFeedbackNotice } from '@peer-agent/protocol';
import { acceptNativeBrowserState } from './nativeBrowserPresentation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserWindowAction, BrowserWindowState } from '@peer-agent/protocol';
import { normalizeBrowserWindowUrl } from '@peer-agent/protocol';
import { createCompositionGuard } from '../chat/state/compositionGuard';
import { PeerIcon, type PeerIconName } from '../ui/icons';
import './resource-native-window.css';


export function NativeBrowserWindow() {
  const api = window.peerBrowserWindow;
  const isZh = (api?.initialLocale || navigator.language).startsWith('zh');
  const [state, setState] = useState<BrowserWindowState | null>(null), [notice, setNotice] = useState('');
  const [feedbackNotice, setFeedbackNotice] = useState<BrowserResourceFeedbackNotice | null>(null);
  const tabId = useRef<string | null>(null); tabId.current = state?.browserTabId ?? null;
  const [address, setAddress] = useState(''), [returning, setReturning] = useState(false), [retry, setRetry] = useState(0);
  const stage = useRef<HTMLDivElement>(null), editing = useRef(false), composition = useRef(createCompositionGuard());
  const accept = (next: BrowserWindowState) => setState(current => acceptNativeBrowserState(current, next));
  useEffect(() => {
    let active = true; if (!api) { setNotice(isZh ? '此窗口暂不可用。' : 'This window is unavailable.'); return; }
    const stop = api.onState(next => { if (active) accept(next); });
    void api.bootstrap().then(result => { if (!active) return; if (result.ok) accept(result.state); else setNotice(isZh ? '此页面实例已失效。' : 'This page instance is no longer available.'); })
      .catch(() => { if (active) setNotice(isZh ? '暂时无法连接此页面，请重试。' : 'Unable to connect to this page. Retry.'); });
    return () => { active = false; stop(); };
  }, [api, retry, isZh]);
  useEffect(() => api?.onFeedbackNotice?.(notice => {
    if (notice.browserTabId === tabId.current) setFeedbackNotice(notice);
  }), [api]);
  useEffect(() => { if (state && !editing.current) setAddress(state.url === 'about:blank' ? '' : state.url); }, [state?.url]);
  useLayoutEffect(() => {
    if (!state || !api || !stage.current) return;
    const el = stage.current; let retired = false;
    const resize = () => {
      const rect = el.getBoundingClientRect();
      void api.viewport({ identity: state.identity, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }).then(result => {
        if (!retired && !result.ok) setNotice(isZh ? '页面布局暂不可用，可重试。' : 'Page layout is unavailable. Retry.');
      }).catch(() => { if (!retired) setNotice(isZh ? '页面布局暂不可用，可重试。' : 'Page layout is unavailable. Retry.'); });
    };
    const observer = new ResizeObserver(resize); observer.observe(el); window.addEventListener('resize', resize); resize();
    return () => { retired = true; observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [state?.identity.viewId, api, retry, isZh]);
  const act = async (action: BrowserWindowAction, url?: string) => {
    if (!api || !state) return;
    setNotice(''); if (action === 'return') setReturning(true);
    try {
      const result = await api.action({ identity: state.identity, action, ...(url ? { url } : {}) });
      if (result.ok) { accept(result.state); if (result.returnStatus === 'source_tab_closed') setNotice(isZh ? '原标签已关闭，已返回原会话。此副本继续保留。' : 'The original tab was closed. Returned to the conversation; this copy is preserved.'); }
      else setNotice(result.status === 'invalid_request' ? (isZh ? '请输入有效的 HTTP 或 HTTPS 网址。' : 'Enter a valid HTTP or HTTPS address.')
        : (isZh ? '此操作暂不可用，当前页面保留，可重试。' : 'This action is unavailable. Your page is preserved. Retry.'));
    } catch { setNotice(isZh ? '连接中断，可重试；当前页面保留。' : 'Connection interrupted. Retry; your page is preserved.'); }
    finally { if (action === 'return') setReturning(false); }
  };
  const go = () => {
    const url = normalizeBrowserWindowUrl(address.trim());
    if (!url) { setNotice(isZh ? '请输入完整的 HTTP 或 HTTPS 网址。' : 'Enter a complete HTTP or HTTPS address.'); return; }
    editing.current = false; void act('navigate', url);
  };
  const feedbackText = feedbackNotice ? browserFeedbackNoticeText(feedbackNotice, isZh) : '';
  const button = (label: string, icon: PeerIconName, action: BrowserWindowAction, disabled = false) => <button type="button" className="ui-button resource-native-icon"
    aria-label={label} title={label} disabled={!state || disabled} onClick={() => void act(action)}><PeerIcon name={icon} size={16} /></button>;
  return <main className="resource-native-shell native-browser-shell">
    <header className="resource-native-header"><PeerIcon name="globe" size={16} /><h1 title={state?.title}>{state?.title || (isZh ? '网页副本' : 'Page copy')}</h1>
      <span className="resource-source-label native-browser-feedback-notice" role={feedbackNotice?.phase === 'failed' ? 'alert' : 'status'} title={feedbackText || (isZh ? '独立页面，共享登录；未复制原页面的表单和浏览历史。' : 'Independent page with shared sign-in. Forms and browsing history were not copied.')}>{feedbackText || (isZh ? '网址副本' : 'Address copy')}</span>
      {button(isZh ? '返回原会话' : 'Return to source conversation', 'back', 'return', returning)}
      {button(isZh ? '关闭此窗口' : 'Close this window', 'close', 'close')}
    </header>
    <div className="native-browser-toolbar">
      {button(isZh ? '后退' : 'Back', 'chevronLeft', 'back', !state?.canBack)}
      {button(isZh ? '前进' : 'Forward', 'chevronRight', 'forward', !state?.canForward)}
      {state?.loading ? button(isZh ? '停止' : 'Stop', 'stop', 'stop') : button(isZh ? '刷新' : 'Reload', 'repeat', 'reload')}
      <input className="ui-input native-browser-address" aria-label={isZh ? '网页地址' : 'Page address'} value={address} spellCheck={false} disabled={!state}
        onFocus={() => { editing.current = true; }} onChange={event => setAddress(event.target.value)} onBlur={() => { editing.current = false; }}
        onCompositionStart={event => composition.current.start(event.currentTarget)} onCompositionEnd={event => composition.current.end(event.currentTarget)}
        onKeyUp={event => composition.current.keyUp(event.nativeEvent)}
        onKeyDown={event => { if (composition.current.keyDown(event.nativeEvent)) return;
          if (event.key === 'Enter') { event.preventDefault(); go(); }
          if (event.key === 'Escape') { editing.current = false; setAddress(state?.url || ''); event.currentTarget.blur(); } }} />
      <button type="button" onClick={go} className="ui-button resource-native-icon" aria-label={isZh ? '前往' : 'Go'} disabled={!state}><PeerIcon name="arrowRight" size={16} /></button>
    </div>
    {notice ? <p className="resource-native-notice" role="alert">{notice}<button type="button" className="ui-button is-compact" onClick={() => { setNotice(''); setRetry(v => v + 1); }}>{isZh ? '重试连接' : 'Reconnect'}</button></p> : null}
    {state?.failure ? <p className="resource-native-notice" role="alert">{state.failure === 'unsupported_address' ? (isZh ? '此链接不是 HTTP 或 HTTPS 地址，当前页面保留。' : 'This link is not HTTP or HTTPS. Your current page is preserved.') : (isZh ? '页面未能加载，可刷新或输入其他网址。' : 'The page could not load. Reload or enter another address.')}</p> : null}
    {!state && !notice ? <p className="resource-native-notice" role="status">{isZh ? '正在连接网页…' : 'Connecting to the page…'}</p> : null}
    <div ref={stage} className="resource-native-content native-browser-stage" aria-label={isZh ? '网页内容' : 'Web content'} />
  </main>;
}
