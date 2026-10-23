import type { I18nRuntime } from '@peer-agent/i18n';
import type { InputRecoveryView, ProjectInputRecovery } from '@peer-agent/runtime-core';
/** Recovery feedback is separate from permission, execution and result facts. */
export function InputRecoveryNotice({ state, session, i18n, pending = false }: {
  readonly state: InputRecoveryView; readonly session: ProjectInputRecovery; readonly i18n: I18nRuntime; readonly pending?: boolean;
}) {
  return <>
    {!state.ready && !state.error ? <p role="status">{i18n.t('projectAgent.chat.draftLoading')}</p> : null}
    {state.error ? <div role="alert" className="bot-thread-error">
      <p>{i18n.t(state.error === 'DRAFT_CONFLICT' ? 'projectAgent.chat.draftConflict' : 'projectAgent.chat.draftSaveFailed')}</p>
      <button type="button" onClick={() => void (state.ready ? session.flush() : session.load())}>{i18n.t('projectAgent.history.retry')}</button>
    </div> : null}
    {pending ? state.pending.map(input => <div key={input.inputId} className="bot-thread-feedback" role="status">
      <span>{i18n.t(state.sending.includes(input.inputId) ? 'projectAgent.chat.sending' : 'projectAgent.chat.inputUnconfirmed')} {input.text.slice(0, 80)}</span>
      <button type="button" disabled={state.sending.includes(input.inputId)} onClick={() => void session.retry(input.inputId)}>{i18n.t('projectAgent.chat.retrySameInput')}</button>
    </div>) : null}
  </>;
}
