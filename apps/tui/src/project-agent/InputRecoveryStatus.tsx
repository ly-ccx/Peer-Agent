import type { InputRecoveryView } from '@peer-agent/runtime-core';
import type { TuiLocale } from '../tui-language.ts';
import { ThemedText } from '../themed-primitives.tsx';
import { COLOR } from '../tui-theme.ts';
import { terminalText } from './commands.ts';
import { projectCopy } from './project-copy.ts';
export function InputRecoveryStatus({ state, locale }: { state: InputRecoveryView; locale: TuiLocale }) {
  return <box flexDirection="column">
    {!state.ready&&!state.error?<ThemedText fg={COLOR.muted}>{projectCopy(locale, 'draftLoading')}</ThemedText>:null}
    {state.error ? <ThemedText fg={COLOR.warning}>{projectCopy(locale, state.error === 'DRAFT_CONFLICT' ? 'draftConflict' : 'draftFailed')} /save-draft</ThemedText> : null}
    {state.pending.map(input => <ThemedText key={input.inputId} fg={COLOR.info}>
      {projectCopy(locale, state.sending.includes(input.inputId) ? 'sending' : 'unconfirmed')} · {terminalText(input.text).slice(0, 80)} · /retry-input {input.inputId}
    </ThemedText>)}
  </box>;
}
