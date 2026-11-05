import { useSyncExternalStore } from 'react';
import type { InteractiveSession } from './interactiveSession';

function failure(code: string | null, isZh: boolean) {
  if (code === 'resource_feedback_attachment_limit' || code === 'RESOURCE_FEEDBACK_ATTACHMENT_LIMIT') return isZh
    ? '原草稿的附件额度不足。请在原对话中整理附件后重试，当前条件仍保留。'
    : 'The original draft has no room for these conditions. Review its attachments and retry. Your conditions are preserved.';
  if (code === 'draft_conflict') return isZh ? '原草稿已变化。请在原对话中处理草稿后重试，当前条件仍保留。'
    : 'The original draft changed. Review it in the conversation and retry. Your conditions are preserved.';
  if (code === 'followup_input_incomplete') return isZh ? '请先完成所选条件的输入，再放入草稿。' : 'Finish the selected inputs before adding them to the draft.';
  return isZh ? '尚未确认放入草稿，原输入和条件仍保留。可以重试原条件，或重新选择当前条件。'
    : 'Draft preparation is unconfirmed. Your input and conditions are preserved. Retry the captured conditions or select the current ones.';
}

/** Native handoff controls. These actions never send, focus the Composer, or start a task. */
export function InteractiveDraftPreparation({ session, isZh }: { readonly session: InteractiveSession; readonly isZh: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot), fields = Object.keys(state.values);
  if (!fields.length) return null;
  const busy = state.draftPreparation === 'preparing' || ['saving', 'freezing'].includes(state.preparation);
  const unavailable = !session.canPrepareDraft(), closed = ['closing', 'closed'].includes(state.phase);
  const readonly = !state.writer || state.phase === 'writer_lost' || closed;
  return <section className="interactive-draft-preparation" aria-label={isZh ? '把条件交回原对话' : 'Return conditions to the original conversation'}>
    <div className="interactive-toolbar"><button type="button" className="ui-button" disabled={unavailable || busy || readonly || state.composing || !!state.calculationError}
      aria-busy={state.draftPreparation === 'preparing'} onClick={() => { void session.prepareDraft(fields); }}>{isZh ? '将当前条件放入草稿' : 'Add current conditions to draft'}</button>
      {state.draftPreparation === 'failed' && state.preparationError !== 'followup_input_incomplete' ? <button type="button" className="ui-button" disabled={unavailable || busy || closed}
        onClick={() => { void session.prepareDraft(); }}>{isZh ? '重试原条件交回' : 'Retry captured conditions'}</button> : null}</div>
    {unavailable ? <p className="interactive-caption">{isZh ? '当前宿主暂不支持条件交回，试算和保存仍可使用。' : 'This host cannot prepare conditions for discussion. Calculation and saving remain available.'}</p>
      : state.draftPreparation === 'preparing' ? <p role="status">{isZh ? '正在将所选条件放入原 Bot 草稿…' : 'Preparing the selected conditions in the original Bot draft…'}</p>
      : state.draftPreparation === 'prepared' ? <p role="status">{isZh ? '已放入原 Bot 草稿。请在原对话中审阅并发送。' : 'Added to the original Bot draft. Review and send from that conversation.'}</p>
      : state.draftPreparation === 'failed' ? <p className="interactive-notice" role="alert">{failure(state.draftError, isZh)}</p> : null}
  </section>;
}
