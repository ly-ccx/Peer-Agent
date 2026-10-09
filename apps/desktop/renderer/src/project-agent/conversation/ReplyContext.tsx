import type { I18nRuntime } from '@peer-agent/i18n';
import { useState, type ReactNode } from 'react';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import type { BotChatMessage } from '../state/botConversationState';
import { readMemoryRecords, type MemoryRecord } from '../state/drawerState';
import { EvidenceList } from './EvidenceList';
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
export function ReplyContext({ i18n, onOpenDetails, running = false }: {
  readonly i18n: I18nRuntime; readonly onOpenDetails?: () => void; readonly running?: boolean;
}) {
  return <div className="bot-reply-context" data-running={running}>
    {running ? <span className="bot-context-running">{i18n.t('projectAgent.chat.generating')}</span> : null}
    <button type="button" onClick={event => {
      event.currentTarget.focus({ preventScroll: true });
      onOpenDetails?.();
    }}>{i18n.t('projectAgent.chat.context.details')}<PeerIcon name="arrowUpRight" size={12} /></button>
  </div>;
}

/** Read-only metadata, rendered exclusively inside the reply detail drawer. */
export function ReplyDetailsContext({ workspaceId, message, i18n, onOpenEvidence, children }: {
  readonly workspaceId: string; readonly message?: BotChatMessage; readonly i18n: I18nRuntime;
  readonly onOpenEvidence?: (id: string) => void; readonly children?: ReactNode;
}) {
  const refs = [...new Set(message?.meta.evidenceRefs ?? [])];
  const surfacing = message?.meta.surfacing;
  const verdicts = message?.marks.filter(mark => mark.outcome && mark.outcome in VERDICTS) ?? [];
  return <div className="bot-reply-context-body">
      {children}
      {refs.length ? <EvidenceList refs={refs} i18n={i18n} onOpen={onOpenEvidence} /> : null}
      <MemoryContext workspaceId={workspaceId} ids={message?.meta.memoryUsed ?? []} i18n={i18n} learned={false} />
      <MemoryContext workspaceId={workspaceId} ids={message?.meta.memoryLearned ?? []} i18n={i18n} learned />
      {verdicts.length || surfacing && surfacing in SURFACING ? <div className="bot-context-metadata">
        {verdicts.map((mark, index) => <span key={index}>{i18n.t(VERDICTS[mark.outcome as keyof typeof VERDICTS])}</span>)}
        {surfacing && surfacing in SURFACING ? <span className="bot-reply-delivery"><PeerIcon name="info" size={13} />{i18n.t('projectAgent.chat.surfacingLabel')}{i18n.t(SURFACING[surfacing as keyof typeof SURFACING])}</span> : null}
      </div> : null}
  </div>;
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
