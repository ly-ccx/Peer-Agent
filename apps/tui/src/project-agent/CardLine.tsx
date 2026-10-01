import {ThemedText} from '../themed-primitives.tsx';import {COLOR} from '../tui-theme.ts';
import type {TuiLocale} from '../tui-language.ts';
import {actionLabel,projectCopy} from './project-copy.ts';import {terminalText,type NumberedCard} from './commands.ts';
export function CardLine({row,locale,selected=false,option=0,isHost}:{row:NumberedCard;locale:TuiLocale;selected?:boolean;option?:number;isHost:boolean}) {
  return <box flexDirection="column" paddingX={1} marginTop={1} backgroundColor={selected?COLOR.selection:COLOR.panel}>
    <ThemedText fg={COLOR.warning}>[{row.number}] {terminalText(row.card.content)}</ThemedText>
    {row.card.actions?.map((action:any,index:number)=><ThemedText key={`${action.id}-${index}`} fg={selected&&option===index?COLOR.accent:COLOR.textSoft}>
      {index+1}. {terminalText(actionLabel(locale,action))}
    </ThemedText>)}
    {!isHost&&['approval','plan_approval','confirm_result'].includes(row.card.kind)?<ThemedText fg={COLOR.muted}>{projectCopy(locale,'desktop')}</ThemedText>:null}
  </box>;
}
