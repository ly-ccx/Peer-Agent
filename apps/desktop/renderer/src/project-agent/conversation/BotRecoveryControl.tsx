import { useState } from 'react';
import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import type { BotRecoveryStatus } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { useBotRecovery } from '../state/useBotRecovery';
import '../styles/bot-recovery-control.css';

const reasons: Record<string, TranslationKey> = {
  history_conflict: 'recovery.reason.conflict', input_ownership: 'recovery.reason.input', delivery_pending: 'recovery.reason.delivery',
  execution_unknown: 'recovery.reason.unknown', budget_unconfirmed: 'recovery.reason.budget', paused: 'recovery.reason.paused',
  coordination_pending: 'recovery.reason.coordination',
  waiting_user: 'recovery.reason.waiting', child_execution: 'recovery.reason.children', checkpoint_unavailable: 'recovery.reason.checkpoint',
  checkpoint_verified: 'recovery.reason.verified',
};
const stages: Partial<Record<string, TranslationKey>> = { stopping: 'recovery.stopping', backing_up: 'recovery.backing_up', restoring: 'recovery.restoring', reconciling: 'recovery.reconciling' };
export function BotRecoveryControl({ workspaceId, status, i18n, onRetry }: {
  readonly workspaceId: string; readonly status: BotRecoveryStatus | null; readonly i18n: I18nRuntime; readonly onRetry: () => void;
}) {
  const recovery = useBotRecovery(workspaceId);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ workId?: string; sessionId?: string } | null>(null);
  const { view, error, busy } = recovery;
  const held = view?.works.filter(work => work.disposition === 'held') || [];
  const resumable = view?.works.filter(work => work.disposition === 'resume') || [];
  const errorKey = error === 'coordination_resume_plan_changed' ? 'recovery.stale'
    : error === 'coordination_recovery_stop_pending' ? 'recovery.stopPending'
    : error === 'RECOVERY_BUSY' ? 'recovery.busy'
      : ['coordination_recovery_identity_conflict', 'coordination_recovery_unbound_delivery'].includes(error || '') ? 'recovery.unsupported' : 'recovery.failed';
  const title = view?.phase === 'failed' ? 'recovery.failed' : status?.code === 'lease_unavailable' || view?.phase === 'occupied' ? 'recovery.occupied'
    : status?.reason === 'history_conflict' ? 'projectAgent.chat.recoveryConflict'
      : status?.reason === 'reconciliation_required' ? 'projectAgent.chat.recoveryReconcile'
        : status ? 'projectAgent.chat.recoveryBlocked' : view?.canContinue ? view.runtimeReady ? 'recovery.ready' : 'recovery.preserved' : 'recovery.title';
  return <section className="bot-recovery-control" aria-label={i18n.t('recovery.title')}>
    <p role="status">{i18n.t(title)}</p>
    <details open={open} onToggle={event => {
      const next = event.currentTarget.open; setOpen(next);
      if (next && !open) recovery.check();
    }}>
      <summary><span>{i18n.t(open ? 'recovery.title' : 'recovery.inspect')}</span><PeerIcon name="chevronDown" size={12} /></summary>
      {busy ? <p role="status">{i18n.t(stages[view?.phase || ''] || 'recovery.checking')}</p> : null}
      {recovery.handoff ? <p role="status">{i18n.t('recovery.handoff')}</p> : null}
      {error ? <p role="alert">{i18n.t(errorKey)}</p> : null}
      {view?.phase === 'occupied' ? <>
        {view.holder ? <p>{i18n.t('recovery.holder', { surface: view.holder.surface === 'desktop' ? 'Desktop' : 'TUI', version: view.holder.version })}</p> : null}
        <button type="button" disabled={busy || recovery.handoff} onClick={() => void recovery.takeover()}>{i18n.t('recovery.takeover')}</button>
      </> : null}
      {view && view.phase !== 'occupied' ? <>
        <p>{i18n.t('recovery.counts', { completed: view.completedCount, resume: resumable.length, held: held.length })}</p>
        <>
          <p>{i18n.t('recovery.backup')}</p>
          <button type="button" disabled={busy} onClick={() => void recovery.execute('restore')}>{i18n.t('recovery.restore')}</button>
        </>
        {view.canContinue && held.length ? <p>{i18n.t('recovery.held')}</p> : null}
        {view.works.length ? <ul>{view.works.map(work => <li key={work.workId}>
          <strong>{work.title === 'Earlier task' ? i18n.t('recovery.earlierTask') : work.title}</strong><p>{i18n.t(reasons[work.reason] || 'recovery.reason.checkpoint')}</p>
          {view.canContinue && work.disposition === 'held' ? <button type="button" disabled={busy}
            onClick={() => setConfirm({ workId: work.workId })}>{i18n.t('recovery.retire')}</button> : null}
        </li>)}</ul> : null}
        {view.sessions.length ? <details><summary><span>{i18n.t('recovery.children')}</span><PeerIcon name="chevronDown" size={12} /></summary>
          <ul>{view.sessions.map(session => <li key={session.sessionId}><strong>{session.title === 'Earlier task' ? i18n.t('recovery.earlierTask') : session.title}</strong>
            {view.canContinue ? <button type="button" disabled={busy} onClick={() => setConfirm({ sessionId: session.sessionId })}>{i18n.t('recovery.retire')}</button> : null}
          </li>)}</ul>
        </details> : null}
      </> : null}
      {confirm ? <div className="bot-recovery-confirm" role="group" aria-label={i18n.t('recovery.confirmRetire')}>
        <p>{i18n.t('recovery.retireHint')}</p>
        <button type="button" disabled={busy} onClick={async () => { await recovery.execute('retain', confirm); setConfirm(null); }}>{i18n.t('recovery.confirmRetire')}</button>
        <button type="button" disabled={busy} onClick={() => setConfirm(null)}>{i18n.t('recovery.cancel')}</button>
      </div> : null}
      <button type="button" disabled={busy} onClick={recovery.check}>{i18n.t('recovery.review')}</button>
      {status?.retryable ? <button type="button" disabled={busy} onClick={onRetry}>{i18n.t('projectAgent.history.retry')}</button> : null}
      {error || status || view?.backupLocation ? <details><summary><span>{i18n.t('recovery.diagnostics')}</span><PeerIcon name="chevronDown" size={12} /></summary>
        {error || status ? <p><code>{error || status?.code}</code>{status?.phase ? ` · ${status.phase}` : ''}</p> : null}
        {view?.backupLocation ? <p>{i18n.t('recovery.savedAt')}<br /><code>{view.backupLocation}</code></p> : null}
      </details> : null}
    </details>
  </section>;
}
