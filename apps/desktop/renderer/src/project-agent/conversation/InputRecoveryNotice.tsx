import { memo, useState } from 'react';
import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import type { InputRecoveryView, ProjectInputRecovery } from '@peer-agent/runtime-core';
import { canRestoreRejectedInput, rejectionLabelKey } from '../state/userReceiptState';

/** Recovery feedback is separate from permission, execution and result facts. */
export const InputRecoveryNotice = memo(function InputRecoveryNotice({ state, session, i18n, pending = false }: {
  readonly state: Pick<InputRecoveryView, 'ready' | 'error' | 'pending' | 'sending'> & Partial<Pick<InputRecoveryView, 'rejected' | 'mutating'>>;
  readonly session: ProjectInputRecovery; readonly i18n: I18nRuntime; readonly pending?: boolean;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ readonly inputId: string; readonly key: TranslationKey } | null>(null);
  return <>
    {!state.ready && !state.error ? <p className="bot-draft-status" role="status"><span className="bot-reading-shimmer">{i18n.t('projectAgent.chat.draftLoading')}</span></p> : null}
    {state.error ? <div role="alert" className="bot-thread-error">
      <p>{i18n.t(state.error === 'DRAFT_CONFLICT' ? 'projectAgent.chat.draftConflict' : 'projectAgent.chat.draftSaveFailed')}</p>
      <button type="button" onClick={() => void (state.ready ? session.flush() : session.load())}>{i18n.t('projectAgent.history.retry')}</button>
    </div> : null}
    {pending ? state.pending.map(input => {
      const sending = state.sending.includes(input.inputId);
      const mutating = Boolean(state.mutating?.includes(input.inputId));
      const busy = sending || mutating;
      const rejectionCode = state.rejected?.[input.inputId];
      const confirming = confirmingId === input.inputId && !rejectionCode && !sending;
      const itemFeedback = feedback?.inputId === input.inputId ? feedback.key : null;
      return <div key={input.inputId} className="bot-thread-feedback" role="status" aria-busy={busy || undefined}>
        {confirming ? <>
          <span>{i18n.t('projectAgent.chat.discardUnconfirmedHint')}</span>
          <div className="bot-thread-feedback-actions">
            <button
              type="button"
              className="bot-user-action-danger"
              disabled={busy}
              onClick={() => void session.discard(input.inputId).then(result => { if (result.ok) setConfirmingId(null); })}
            >{i18n.t('projectAgent.chat.confirmDiscardPending')}</button>
            <button type="button" disabled={busy} onClick={() => setConfirmingId(null)}>{i18n.t('projectAgent.chat.cancelDiscardPending')}</button>
          </div>
        </> : <>
          <span>
            {i18n.t(sending ? 'projectAgent.chat.sending' : rejectionCode ? rejectionLabelKey(rejectionCode) : 'projectAgent.chat.inputUnconfirmed')} {input.text.slice(0, 80)}
            {itemFeedback ? ` ${i18n.t(itemFeedback)}` : ''}
          </span>
          <div className="bot-thread-feedback-actions">
            {!rejectionCode ? (
              <button type="button" disabled={busy} onClick={() => { setFeedback(null); void session.retry(input.inputId); }}>
                {i18n.t('projectAgent.chat.retrySameInput')}
              </button>
            ) : null}
            {!rejectionCode || canRestoreRejectedInput(rejectionCode) ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void session.restoreToDraft(input.inputId).then(result => {
                  if (!result.ok && result.code === 'DRAFT_NOT_EMPTY') setFeedback({ inputId: input.inputId, key: 'projectAgent.chat.restoreDraftOccupied' });
                  else setFeedback(null);
                })}
              >{i18n.t('projectAgent.chat.restoreToDraft')}</button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setFeedback(null);
                if (rejectionCode) void session.discard(input.inputId);
                else setConfirmingId(input.inputId);
              }}
            >{i18n.t(rejectionCode ? 'projectAgent.chat.deletePending' : 'projectAgent.chat.removePending')}</button>
          </div>
        </>}
      </div>;
    }) : null}
  </>;
});
