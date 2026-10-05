import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import type { BotChatMessage } from '../state/botConversationState';
import { readMemoryRecords, type MemoryRecord } from '../state/drawerState';
import '../styles/bot-reply-context.css';

const VERDICTS = {
  passed: 'projectAgent.chat.verdict.passed', failed: 'projectAgent.chat.verdict.failed',
  partial: 'projectAgent.chat.verdict.partial', unverifiable: 'projectAgent.chat.verdict.unverifiable',
} as const;
const SURFACING = {
  interrupt: 'projectAgent.chat.surfacing.interrupt', message: 'projectAgent.chat.surfacing.message',
  digest: 'projectAgent.chat.surfacing.digest', silent: 'projectAgent.chat.surfacing.silent',
} as const;

/** Reply metadata stays discoverable without competing with the answer or pending work. */
export function ReplyContext({ workspaceId, message, i18n, onOpenEvidence, onOpenProcess }: {
  readonly workspaceId: string; readonly message: BotChatMessage; readonly i18n: I18nRuntime;
  readonly onOpenEvidence?: (id: string) => void; readonly onOpenProcess?: () => void;
}) {
  const refs = [...new Set(message.meta.evidenceRefs ?? [])];
  const surfacing = message.meta.surfacing;
  return <details className="bot-reply-context">
    <summary><PeerIcon name="fileText" size={13} /><span>{i18n.t(refs.length ? 'projectAgent.chat.context.basis' : 'projectAgent.chat.context.details', { count: refs.length })}</span><PeerIcon name="chevronDown" size={12} /></summary>
    <div className="bot-reply-context-body">
      {refs.length ? <section aria-label={i18n.t('projectAgent.chat.evidence')}>
        <h3>{i18n.t('projectAgent.chat.evidence')}</h3>
        <ol className="bot-evidence-list">{refs.map((ref, index) => <li key={ref}><button type="button" onClick={() => onOpenEvidence?.(ref)}>
          <PeerIcon name="fileText" size={13} /><span>{i18n.t('projectAgent.chat.evidence')} {index + 1}</span><PeerIcon name="arrowUpRight" size={12} />
        </button></li>)}</ol>
      </section> : null}
      <MemoryContext workspaceId={workspaceId} ids={message.meta.memoryUsed ?? []} i18n={i18n} learned={false} />
      <MemoryContext workspaceId={workspaceId} ids={message.meta.memoryLearned ?? []} i18n={i18n} learned />
      {onOpenProcess ? <button className="bot-context-process" type="button" onClick={onOpenProcess}><PeerIcon name="terminal" size={14} />{i18n.t('projectAgent.chat.openProcess')}</button> : null}
      <div className="bot-context-metadata">
        {message.marks.map((mark, index) => mark.outcome && mark.outcome in VERDICTS ?
          <span key={index}>{i18n.t(VERDICTS[mark.outcome as keyof typeof VERDICTS])}</span> : null)}
        {surfacing && surfacing in SURFACING ? <span className="bot-reply-delivery"><PeerIcon name="info" size={13} />{i18n.t('projectAgent.chat.surfacingLabel')}{i18n.t(SURFACING[surfacing as keyof typeof SURFACING])}</span> : null}
      </div>
    </div>
  </details>;
}

function MemoryContext({ workspaceId, ids, i18n, learned }: { readonly workspaceId: string; readonly ids: readonly string[]; readonly i18n: I18nRuntime; readonly learned: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<readonly MemoryRecord[]>([]);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!ids.length) return null;
  return <div className="bot-memory-chip"><button type="button" aria-expanded={open} disabled={pending} onClick={() => {
    if (open) { setOpen(false); return; }
    setPending(true); setFailed(false);
    void clientApi.projectMemoryList({ workspaceId, ids }).then(result => {
      const records = readMemoryRecords(result?.items);
      setRows(records.filter(item => ids.includes(item.id))); setOpen(true);
    }).catch(() => { setFailed(true); setOpen(true); }).finally(() => setPending(false));
  }}><PeerIcon name="fileText" size={13} />{i18n.t(learned ? 'projectAgent.chat.memoryLearned' : 'projectAgent.chat.memoryUsed', { count: ids.length })}<PeerIcon name={open ? 'chevronUp' : 'chevronDown'} size={12} /></button>
    {open ? rows.length ? <ul>{rows.map(row => <li key={row.id}>{row.text}</li>)}</ul> : <p role={failed ? 'alert' : 'status'}>{i18n.t('projectAgent.chat.context.memoryUnavailable')}</p> : null}
  </div>;
}
