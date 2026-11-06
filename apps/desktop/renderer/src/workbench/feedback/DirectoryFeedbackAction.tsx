import { feedbackPreparationFailureText } from './browserFeedbackNotice';
import { useMemo, useRef, useState } from 'react';
import { normalizeResourceFeedback, type BotDocumentReference, type ResourceFeedback } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { useResourceFeedback } from './ResourceFeedbackContext';
import { feedbackDigest } from './resourceSelection';
import { directoryFeedbackExcerpt } from './directoryFeedback';
export function DirectoryFeedbackAction({ reference, entries, selected, incomplete, isZh, active }: {
  readonly reference: BotDocumentReference; readonly entries?: readonly { readonly name: string; readonly isDir: boolean }[];
  readonly selected: string | null; readonly incomplete: boolean; readonly isZh: boolean; readonly active: boolean;
}) {
  const port = useResourceFeedback(), pending = useRef<{ key: string; feedback: ResourceFeedback } | null>(null);
  const busy = useRef<string | null>(null);
  const [state, setState] = useState<{ key: string; busy: boolean; message: string } | null>(null);
  const base = JSON.stringify([reference, selected, incomplete, port?.recipient]);
  const key = useMemo(() => crypto.randomUUID(), [base, entries]);
  const live = useRef(key); live.current = key;
  if (!port || !entries || !active) return null;
  const capture = async () => {
    if (busy.current === key) return;
    busy.current = key;
    const snapshot = entries.map(item => ({ name: item.name, isDir: item.isDir })), recipient = { ...port.recipient };
    const target = { ...reference }, excerpt = directoryFeedbackExcerpt(snapshot, selected, incomplete, isZh);
    setState({ key, busy: true, message: '' });
    try {
      let row = pending.current?.key === key ? pending.current.feedback : null;
      if (!row) {
        row = normalizeResourceFeedback({ id: crypto.randomUUID(), recipient, resource: { kind: 'directory', reference: target },
          version: { kind: 'directory-list', digest: await feedbackDigest(JSON.stringify({ entries: snapshot, incomplete })) },
          excerpt, capturedAt: new Date().toISOString(), selection: { kind: 'discussion', ...(selected ? { path: selected } : {}) } }) ?? null;
        if (!row) throw Error('INVALID_RESOURCE_FEEDBACK');
        if (live.current === key) pending.current = { key, feedback: row };
      }
      const result = await port.prepare(row);
      if (live.current === key) setState({ key, busy: false, message: result.ok ? (isZh ? '已加入此 Bot 草稿，尚未发送。' : 'Added to this Bot’s draft; not sent.')
        : feedbackPreparationFailureText(result.code, isZh) });
    } catch { if (live.current === key) setState({ key, busy: false, message: isZh ? '无法准备目录引用，可能超过大小限制。' : 'Unable to prepare the listing reference. It may exceed the size limit.' }); }
    finally { if (busy.current === key) busy.current = null; }
  };
  return <div className="resource-directory-feedback"><button type="button" className="ui-button is-compact" disabled={state?.key === key && state.busy} onClick={() => void capture()}><PeerIcon name="fileText" size={14} />{isZh ? '引用此清单' : 'Reference this listing'}</button>
    {state?.key === key && state.message ? <span className="resource-source-label" title={state.message} role="status">{state.message}</span> : null}</div>;
}
