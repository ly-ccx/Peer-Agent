import {ThemedText} from '../themed-primitives.tsx';import {COLOR,MARKDOWN_CHROME} from '../tui-theme.ts';
import {CardLine} from './CardLine.tsx';import {projectCopy,projectStatus} from './project-copy.ts';
import {replyEchoText,terminalText,type NumberedCard} from './commands.ts';import type {TuiLocale} from '../tui-language.ts';
export function BotConversationView({messages,cards,locale,isHost,selectedCard,option,cardFocus}:{messages:readonly any[];cards:readonly NumberedCard[];locale:TuiLocale;isHost:boolean;selectedCard:number;option:number;cardFocus:boolean}) {
  const byId=new Map(messages.map(row=>[row.id,row]));
  const visible=messages.filter(row=>['user_input','agent_reply','system_card'].includes(row.kind));
  return <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" focused={false}>
    {!visible.length?<ThemedText fg={COLOR.muted}>{projectCopy(locale,'empty')}</ThemedText>:null}
    {visible.map(message=><box key={message.id} flexDirection="column" marginBottom={1} paddingX={1}>
      {message.kind!=='system_card'?<ThemedText fg={message.kind==='user_input'?COLOR.user:COLOR.accent}>{projectCopy(locale,message.kind==='user_input'?'you':'bot')}</ThemedText>:null}
      {(()=>{const anchors:string[]=message.replyTo??message.meta?.replyTo??[];if(!anchors.length)return null;
        // 回显只用一行：原话折叠成单行、按列宽截断，前置引用条与正文区分开。
        const echo=anchors.map((id:string)=>replyEchoText(byId.get(id)?.content??id)).filter(Boolean).map((text:string)=>`${MARKDOWN_CHROME.quotePrefix}${text}`).join(' ');
        return echo?<ThemedText fg={COLOR.textSoft}>{projectCopy(locale,'replied')}: {echo}</ThemedText>:null;})()}
      {message.content?<ThemedText selectable fg={COLOR.text}>{terminalText(message.content)}</ThemedText>:null}
      {message.marks?.length?<ThemedText fg={COLOR.success}>{projectCopy(locale,'marks')}: {message.marks.map((mark:any)=>terminalText(projectStatus(locale,mark.outcome??mark.state??'')).toString()).join(' · ')}</ThemedText>:null}
    </box>)}
    {cards.map((row,index)=><CardLine key={row.card.cardId} row={row} locale={locale} isHost={isHost} selected={cardFocus&&index===selectedCard} option={option}/>)}
  </scrollbox>;
}
