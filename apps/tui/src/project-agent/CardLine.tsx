import {ThemedText} from '../themed-primitives.tsx';import {COLOR} from '../tui-theme.ts';
import type {TuiLocale} from '../tui-language.ts';
import {actionLabel,projectCopy} from './project-copy.ts';import {terminalText,type NumberedCard} from './commands.ts';
import {cardSummary,isRecoveryCard} from './card-presentation.ts';
export function CardLine({row,locale,selected=false,isHost}:{row:NumberedCard;locale:TuiLocale;selected?:boolean;option?:number;isHost:boolean}) {
  return <box flexDirection="column" paddingX={1} marginTop={1} backgroundColor={selected?COLOR.selection:COLOR.panel}>
    <ThemedText fg={COLOR.warning}>[{row.number}] {cardSummary(locale,row.card)}</ThemedText>
    {isRecoveryCard(row.card)?<ThemedText selectable fg={COLOR.muted}>{selected?terminalText(row.card.content):projectCopy(locale,'diagnosticHint')}</ThemedText>:null}
    {null /* Actions stay on the composer row, not inside the card. */}
    {!isHost&&['approval','plan_approval','confirm_result'].includes(row.card.kind)?<ThemedText fg={COLOR.muted}>{projectCopy(locale,'desktop')}</ThemedText>:null}
  </box>;
}
