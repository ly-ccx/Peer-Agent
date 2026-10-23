import {useTerminalDimensions} from '@opentui/react';
import {ThemedText} from '../themed-primitives.tsx';import {COLOR} from '../tui-theme.ts';
import {MarkdownView} from '../markdown-view.tsx';
import {CardLine} from './CardLine.tsx';import {projectCopy,projectStatus} from './project-copy.ts';
import {cardSummary,isRecoveryCard} from './card-presentation.ts';
import {terminalText,type NumberedCard} from './commands.ts';import type {TuiLocale} from '../tui-language.ts';
export function BotConversationView({messages,cards,locale,isHost,selectedCard,option,cardFocus}:{messages:readonly any[];cards:readonly NumberedCard[];locale:TuiLocale;isHost:boolean;selectedCard:number;option:number;cardFocus:boolean}) {
  const terminal=useTerminalDimensions();
  const byId=new Map(messages.map(row=>[row.id,row]));
  const numbered=new Map(cards.map(row=>[row.card.cardId,row]));
  const visible=messages.filter(row=>['user_input','agent_reply','system_card'].includes(row.kind));
  const attached=new Set(visible.flatMap(message=>(message.cards??[]).map((card:any)=>card.cardId)));
  function renderCard(card:any) {
    const row=numbered.get(card.cardId);
    if(row)return <CardLine key={card.cardId} row={row} locale={locale} isHost={isHost} selected={cardFocus&&cards[selectedCard]?.card.cardId===card.cardId} option={option}/>;
    return isRecoveryCard(card)?<ThemedText key={card.cardId} fg={COLOR.muted}>{cardSummary(locale,card)} · /diagnostics</ThemedText>:null;
  }
  return <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" focused={false}>
    {!visible.length?<ThemedText fg={COLOR.muted}>{projectCopy(locale,'empty')}</ThemedText>:null}
    {visible.map(message=><box key={message.id} flexDirection="column" marginBottom={1} paddingX={1}>
      {message.kind!=='system_card'?<ThemedText fg={message.kind==='user_input'?COLOR.user:COLOR.accent}>{projectCopy(locale,message.kind==='user_input'?'you':'bot')}</ThemedText>:null}
      {(message.replyTo??message.meta?.replyTo??[]).length?<ThemedText fg={COLOR.muted}>{projectCopy(locale,'replied')}: {(message.replyTo??message.meta.replyTo).map((id:string)=>terminalText(byId.get(id)?.content??id).slice(0,70)).join(' · ')}</ThemedText>:null}
      {message.content&&!(message.kind==='system_card'&&message.cards?.length)
        ?message.kind==='agent_reply'?<MarkdownView content={terminalText(message.content)} width={terminal.width-4}/>
          :<ThemedText selectable fg={COLOR.text}>{terminalText(message.content)}</ThemedText>
        :null}
      {message.marks?.length?<ThemedText fg={COLOR.success}>{projectCopy(locale,'marks')}: {[...new Set(message.marks.map((mark:any)=>terminalText(projectStatus(locale,mark.outcome??mark.state??''))))].join(' · ')}</ThemedText>:null}
      {(message.cards??[]).map(renderCard)}
    </box>)}
    {cards.filter(row=>!attached.has(row.card.cardId)).map(row=>renderCard(row.card))}
  </scrollbox>;
}
