import { feedbackPreparationFailureText } from './browserFeedbackNotice';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { normalizeResourceFeedback, type ResourceFeedback, type ResourceFeedbackResource, type ResourceFeedbackVersion } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { useResourceFeedback } from './ResourceFeedbackContext';
import { captureResourceSelection, feedbackDigest, type ResourceTextSelection } from './resourceSelection';

export function ResourceSelectionFeedback({ container, resource, version, digestText, sourceContent, discussionPath, active = true, isZh }: {
  readonly container: RefObject<HTMLElement | null>; readonly resource: ResourceFeedbackResource | null;
  readonly version?: ResourceFeedbackVersion; readonly digestText?: string; readonly sourceContent?: string;
  readonly discussionPath?: string; readonly active?: boolean; readonly isZh: boolean;
}) {
  const port = useResourceFeedback();
  const baseIdentity = JSON.stringify([resource, version, discussionPath, port?.recipient]);
  const identity = useMemo(() => crypto.randomUUID(), [baseIdentity, digestText, sourceContent]);
  const busy = useRef<string | null>(null);
  const [capture, setCapture] = useState<{ identity: string; value: ResourceTextSelection } | null>(null);
  const [state, setState] = useState<{ identity: string; message: string; busy: boolean } | null>(null);
  const pending = useRef<{ key: string; feedback: ResourceFeedback } | null>(null);
  const live = useRef(identity); live.current = identity;
  useEffect(() => {
    if (!port || !resource || !active) return;
    const changed = () => {
      const node = container.current;
      const value = node ? captureResourceSelection(node, window.getSelection(), sourceContent, discussionPath) : null;
      if (value) setCapture({ identity, value });
      else if (!document.activeElement?.closest('.resource-selection-feedback')) setCapture(null);
    };
    document.addEventListener('selectionchange', changed);
    return () => document.removeEventListener('selectionchange', changed);
  }, [identity, active, !!port, container]);
  if (!port || !resource || !active || capture?.identity !== identity) return null;
  const prepare = async () => {
    if (busy.current === identity) return;
    busy.current = identity;
    const value = capture.value, recipient = { ...port.recipient }, target = resource, capturedVersion = version;
    const key = JSON.stringify([identity, value]);
    setState({ identity, busy: true, message: '' });
    try {
      let row = pending.current?.key === key ? pending.current.feedback : null;
      if (!row) {
        const base = capturedVersion ?? (digestText !== undefined ? { kind: target.kind === 'directory' ? 'directory-list' as const : 'comparison' as const, digest: await feedbackDigest(digestText) } : undefined);
        row = normalizeResourceFeedback({ id: crypto.randomUUID(), recipient, capturedAt: new Date().toISOString(), resource: target, version: base, ...value }) ?? null;
        if (!row) throw Error('INVALID_RESOURCE_FEEDBACK');
        if (live.current === identity) pending.current = { key, feedback: row };
      }
      const result = await port.prepare(row);
      if (live.current === identity) setState({ identity, busy: false, message: result.ok
        ? (isZh ? '已加入此 Bot 的输入草稿，填写问题后发送。' : 'Added to this Bot’s input draft. Write your question, then send.')
        : feedbackPreparationFailureText(result.code, isZh) });
    } catch { if (live.current === identity) setState({ identity, busy: false, message: isZh ? '无法准备此引用；请检查选区或重试。' : 'Unable to prepare this reference. Check the selection or retry.' }); }
    finally { if (busy.current === identity) busy.current = null; }
  };
  return <div className="resource-selection-feedback">
    <button type="button" className="ui-button is-compact" disabled={state?.identity === identity && state.busy}
      onPointerDown={event => event.preventDefault()} onClick={() => void prepare()}><PeerIcon name="fileText" size={14} />{isZh ? '针对这段提问' : 'Ask about this selection'}</button>
    {capture.value.selection.kind === 'discussion' ? <span className="resource-source-label">{isZh ? '讨论引用' : 'Discussion reference'}</span> : null}
    {state?.identity === identity && state.message ? <span className="resource-source-label" role="status">{state.message}</span> : null}
  </div>;
}
