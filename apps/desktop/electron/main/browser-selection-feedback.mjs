import { randomUUID } from 'node:crypto';
import { normalizeResourceFeedback, normalizeBrowserWindowUrl, RESOURCE_FEEDBACK_EXCERPT_LIMIT } from '@peer-agent/protocol';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Reads only Electron's user context-menu selection facts. Never executes page JavaScript. */
export function bindBrowserSelectionFeedback({ contents, getBinding, prepare, popup, report = () => {}, isZh = () => false, createId = randomUUID }) {
  let disposed = false, topDocument = createId(), lastAttempt = null;
  const frames = new Map();
  const frameKey = frame => { try { return frame && !frame.detached ? `${frame.processId}:${frame.routingId}:${frame.frameToken}` : null; } catch { return null; } };
  const navigation = details => {
    if (details?.isMainFrame) { topDocument = createId(); frames.clear(); }
    const key = frameKey(details?.frame);
    if (key) { frames.delete(key); frames.set(key, createId()); }
    else { topDocument = createId(); frames.clear(); }
    while (frames.size > 256) frames.delete(frames.keys().next().value);
  };
  const onMenu = (event, params) => {
    if (disposed || typeof params?.selectionText !== 'string' || !params.selectionText.trim()) return;
    let binding, pageUrl, frame, url;
    try {
      binding = getBinding(); if (!binding?.sourceSender || !binding.recipient) return;
      pageUrl = normalizeBrowserWindowUrl(contents.getURL()); frame = params.frame;
      url = normalizeBrowserWindowUrl(frame?.url || params.frameURL || params.pageURL || pageUrl);
    } catch { return; }
    const key = frameKey(frame);
    const enabled = !!pageUrl && !!url && !!key && params.selectionText.length <= RESOURCE_FEEDBACK_EXCERPT_LIMIT;
    const zh = isZh();
    if (key && !frames.has(key)) { frames.set(key, createId()); while (frames.size > 256) frames.delete(frames.keys().next().value); }
    const generation = key ? frames.get(key) : null, epoch = topDocument, excerpt = params.selectionText;
    const identity = binding.identity ?? { viewId: `browser-${contents.id}`, windowId: `main-${binding.sourceSender.id}`, generation };
    const current = () => {
      try {
        const now = getBinding();
        return !disposed && !contents.isDestroyed() && now?.sourceSender === binding.sourceSender
          && equal(now.recipient, binding.recipient) && equal(now.identity, binding.identity)
          && now.browserTabId === binding.browserTabId && now.conversationId === binding.conversationId
          && topDocument === epoch && frames.get(key) === generation && params.frame === frame && frameKey(frame) === key
          && normalizeBrowserWindowUrl(contents.getURL()) === pageUrl && normalizeBrowserWindowUrl(frame.url) === url;
      } catch { return false; }
    };
    event.preventDefault?.();
    popup({ label: enabled ? (zh ? '针对这段提问' : 'Ask about this selection')
      : params.selectionText.length > RESOURCE_FEEDBACK_EXCERPT_LIMIT ? (zh ? '选区过大，请缩小到 8192 字符以内' : 'Select at most 8192 characters')
        : (zh ? '此页面选区暂不支持引用' : 'Selection references are unavailable for this page'), enabled,
      onClick: async () => {
        const notice = value => report({ webContentsId: contents.id, conversationId: binding.conversationId, browserTabId: binding.browserTabId, ...value });
        if (!enabled || !current()) { notice({ phase: 'failed', code: 'SOURCE_CHANGED' }); return; }
        const seed = { recipient: { ...binding.recipient }, resource: { kind: 'web', url, ...(url !== pageUrl ? { pageUrl } : {}), conversationId: binding.conversationId, browserTabId: binding.browserTabId },
          version: { kind: 'web-document', documentId: generation }, excerpt, selection: { kind: 'discussion' } };
        const materialKey = JSON.stringify(seed);
        if (!lastAttempt || lastAttempt.key !== materialKey) {
          const feedback = normalizeResourceFeedback({ ...seed, id: createId(), capturedAt: new Date().toISOString() });
          if (!feedback) { notice({ phase: 'failed', code: 'INVALID_RESOURCE_FEEDBACK' }); return; }
          lastAttempt = { key: materialKey, feedback };
        }
        notice({ phase: 'preparing' });
        try {
          const result = await prepare({ sourceSender: binding.sourceSender, identity, feedback: lastAttempt.feedback, isCurrent: current });
          if (!disposed) notice(result.ok ? { phase: 'prepared' } : { phase: result.code === 'DRAFT_PREPARATION_UNCONFIRMED' ? 'unconfirmed' : 'failed', code: result.code });
        } catch { if (!disposed) notice({ phase: 'unconfirmed', code: 'DRAFT_PREPARATION_UNCONFIRMED' }); }
      }, params });
  };
  contents.on('context-menu', onMenu); contents.on('did-start-navigation', navigation);
  let remove;
  remove = () => { if (disposed) return; disposed = true; frames.clear(); lastAttempt = null;
    contents.removeListener('context-menu', onMenu); contents.removeListener('did-start-navigation', navigation); contents.removeListener('destroyed', remove); };
  contents.once('destroyed', remove); return remove;
}
