import {cardFocusIntent} from './cardFocus.ts';
import {createProjectReadState} from './projectReadState.ts';
import { useProjectInputDraft } from './useProjectInputDraft.ts';
import { InputRecoveryStatus } from './InputRecoveryStatus.tsx';
import { composerEnterAction } from '../runtime-controls.ts';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useKeyboard,useTerminalDimensions} from '@opentui/react';
import type {TextareaRenderable} from '@opentui/core';
import {ThemedText,ThemedTextarea} from '../themed-primitives.tsx';
import {COLOR,type TuiThemeStore} from '../tui-theme.ts';
import type {TuiLocale} from '../tui-language.ts';
import type {createTuiProjectHost} from './tui-project-host.ts';
import type {createTuiProjectClient} from './tui-project-client.ts';
import {BotListView} from './BotListView.tsx';
import {BotConversationView} from './BotConversationView.tsx';
import {CardLine} from './CardLine.tsx';
import {cardAction,createCardNumbers,parseProjectCommand,terminalText} from './commands.ts';
import {runProjectCardAction} from './card-actions.ts';
import {projectCopy,projectStatus} from './project-copy.ts';
import {isRecoveryCard} from './card-presentation.ts';
import {isEnterKeyName} from '../runtime-controls.ts';

type Host=ReturnType<typeof createTuiProjectHost>;
type Client=ReturnType<typeof createTuiProjectClient>;
type View='bind'|'bots'|'conversation'|'tasks'|'task'|'memory'|'objectives'|'cards'|'diagnostics'|'help';
export function ProjectApp({host,client,initialView,workspacePath,locale,themeStore,onClassic,onQuit}:{host:Host;client:Client;initialView:'bind'|'bots'|'conversation';workspacePath:string;locale:TuiLocale;themeStore:TuiThemeStore;onClassic():Promise<void>;onQuit():void}) {
  const terminal=useTerminalDimensions(), editor=useRef<TextareaRenderable|null>(null),numbers=useRef(createCardNumbers());
  const [snapshot,setSnapshot]=useState(()=>client.current()),[view,setView]=useState<View>(initialView),[selected,setSelected]=useState(0);
  const [cardIndex,setCardIndex]=useState(0),[option,setOption]=useState(0),[bindYes,setBindYes]=useState(true),[detail,setDetail]=useState<any>(null);
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[earlier,setEarlier]=useState(false),[,setTheme]=useState(themeStore.getState());
  const inputDraft=useProjectInputDraft(client,snapshot.workspaceId,editor,view);
  const operationPending=useRef(false);
  const [cardFocus,setCardFocus]=useState(false);
  useEffect(()=>setCardFocus(false),[view,snapshot.workspaceId]);
  const copy=(key:Parameters<typeof projectCopy>[1])=>projectCopy(locale,key);
  const offer=snapshot.familiarizeOffer;
  const displayedMessages=offer?[...snapshot.messages,{id:`offer:${snapshot.workspaceId}`,kind:'system_card',cards:[{
    cardId:`offer:familiarize:${snapshot.workspaceId}`,kind:'familiarize',content:copy('familiarizeQuestion'),
    actions:[{id:'familiarize',channel:'project-agent:start-familiarize',payload:{}}],
  }]}]:snapshot.messages;
  const cards=numbers.current.project(snapshot.workspaceId,displayedMessages);
  const focusedCard=useRef<string|null>(null);
  useEffect(()=>{
    if(!cardFocus){focusedCard.current=null;return;}
    const id=focusedCard.current;
    if(id){const index=cards.findIndex(row=>row.card.cardId===id);if(index<0){setCardFocus(false);return;}if(index!==cardIndex)setCardIndex(index);}
    else focusedCard.current=cards[cardIndex]?.card.cardId??null;
  },[cards,cardFocus]);
  useEffect(()=>{if(cardFocus)focusedCard.current=cards[cardIndex]?.card.cardId??null;},[cardIndex,cardFocus]);
  const bot=snapshot.bots.find(row=>row.workspaceId===snapshot.workspaceId);
  const refresh=()=>{void client.poll(true).then(setSnapshot).catch(()=>setNotice(copy('error')));};
  useEffect(()=>{let live=true;const read=()=>{void client.poll().then(next=>{if(live)setSnapshot(next);}).catch(()=>{if(live)setNotice(copy('error'));});};read();const timer=setInterval(read,1000);return()=>{live=false;clearInterval(timer);};},[client]);
  useEffect(()=>themeStore.subscribe(setTheme),[themeStore]);
  useEffect(()=>{if(inputDraft.state.ready&&!busy&&!cardFocus&&!['bind','bots','cards'].includes(view))queueMicrotask(()=>editor.current?.focus());},[view,busy,cardFocus,inputDraft.state.ready,inputDraft.session]);
  const lastId=snapshot.messages.filter(row=>['user_input','agent_reply','system_card'].includes(row.kind)).at(-1)?.id;
  useEffect(()=>{if(view==='conversation'&&!earlier&&snapshot.workspaceId&&snapshot.messageState==='ready')host.directory.markRead(snapshot.workspaceId);},[lastId,snapshot.workspaceId,snapshot.messageState,view,earlier]);
  async function perform(run:()=>Promise<any>|any,success=copy('done')) {
    if(operationPending.current)return {ok:false};
    operationPending.current=true;setBusy(true);
    try {const result=await run();if(result?.ok===false){setNotice(result.error==='desktop_approval_required'?copy('desktop'):`${copy('error')}: ${terminalText(result.error??result.code??'')}`);}else setNotice(result?.approval ? projectStatus(locale,result.approval.state) : success);refresh();return result;}
    catch {setNotice(copy('error'));}
    finally {operationPending.current=false;setBusy(false);}
  }
  async function openBot(index:number) {
    const selectedBot=snapshot.bots[index];if(!selectedBot)return;
    await perform(async()=>{setSnapshot(await client.select(selectedBot.workspaceId));setView('conversation');setEarlier(false);});
  }
  function openClassic() {setNotice(copy('leaving'));void perform(onClassic);}
  function submit(text:string) {
    const command=parseProjectCommand(text);
    if(command.kind==='text'){if(command.text)void perform(async()=>{void client.latest().catch(()=>{});setEarlier(false);setView('conversation');return inputDraft.session.send({text:command.text});},copy('received'));return;}
    if(command.kind==='retry_input'){void perform(()=>inputDraft.session.retry(command.inputId),copy('received')).then(result=>{if((result?.ok||result?.input)&&inputDraft.session.getSnapshot().draft.text===text)inputDraft.session.edit({text:''});});return;}
    if(command.kind==='save_draft'){void (inputDraft.state.ready?inputDraft.session.flush():inputDraft.session.load());return;}
    if(command.kind==='invalid'){setNotice(copy('invalid'));return;}
    if(command.kind==='view'){inputDraft.session.edit({text:''});setView(command.view);setSelected(0);setCardIndex(0);setOption(0);return;}
    if(command.kind==='classic'){openClassic();return;}
    if(command.kind==='takeover'){void perform(()=>host.takeover(),copy('takeover'));return;}
    if(command.kind==='older'){inputDraft.session.edit({text:''});void client.earlier().then(setSnapshot);setEarlier(true);setView('conversation');return;}
    if(command.kind==='latest'){inputDraft.session.edit({text:''});void client.latest().then(setSnapshot);setEarlier(false);setView('conversation');return;}
    if(command.kind==='help'){inputDraft.session.edit({text:''});setView('help');return;}
    if(command.kind==='task'){
      const session=snapshot.sessions[command.number-1];if(!session){setNotice(copy('invalid'));return;}
      inputDraft.session.edit({text:''});setDetail(host.supervisor.get({sessionId:session.sessionId,detail:'report'}));setView('task');return;
    }
    if(command.kind!=='card')return;
    const action=cardAction(command,cards);
    if(!action){setNotice(copy('invalid'));return;}
    void perform(()=>runProjectCardAction(host,client,action)).then(result=>{
      if((result?.ok || result?.inputReceived) && inputDraft.session.getSnapshot().draft.text===text) inputDraft.session.edit({text:''});
    });
  }
  function selectedCardAction() {
    const row=cardFocus&&focusedCard.current?cards.find(row=>row.card.cardId===focusedCard.current):cards[Math.min(cardIndex,cards.length-1)],action=row?.card.actions?.[option];
    if(!row||!action)return;
    if(action.id==='answer'&&!action.payload?.text){setCardFocus(false);setView('conversation');inputDraft.session.edit({text:`/answer ${row.number} `});return;}
    void perform(()=>runProjectCardAction(host,client,action));
  }
  useKeyboard(key=>{
    if((key as {isComposing?:boolean}).isComposing)return;
    if(key.ctrl&&key.name==='c'){key.preventDefault();editor.current?.blur();setBusy(true);setNotice(copy('leaving'));onQuit();return;}
    if(busy)return;
    if(key.name==='f2'){key.preventDefault();key.stopPropagation();openClassic();return;}
    if(view==='conversation'&&cardFocus&&key.name==='escape'){key.preventDefault();key.stopPropagation();setCardFocus(false);return;}
    if(key.name==='escape'){key.preventDefault();if(view==='bind')void perform(onClassic);else setView('conversation');return;}
    if(view==='bind'){
      if(['left','right','up','down','tab'].includes(key.name)){key.preventDefault();setBindYes(!bindYes);}
      if(key.name==='y'||key.name==='n'||isEnterKeyName(key.name)){
        key.preventDefault();const accept=key.name==='y'||(isEnterKeyName(key.name)&&bindYes);
        if(!accept){void perform(onClassic);return;}
        void perform(async()=>{const entry=host.registry.ensureForPath(workspacePath);const created=host.lifecycle.ensureBot(entry.workspaceId) as any;
          if(!created.ok)return created;if(created.profile.status==='archived')host.lifecycle.restoreBot(entry.workspaceId);
          setSnapshot(await client.select(entry.workspaceId));setView('conversation');return {ok:true};});
      }return;
    }
    if(view==='bots'){
      if(key.name==='down'||key.name==='up'){key.preventDefault();setSelected(Math.max(0,Math.min(snapshot.bots.length-1,selected+(key.name==='down'?1:-1))));}
      if(isEnterKeyName(key.name)){key.preventDefault();void openBot(selected);}return;
    }
    if(view==='conversation') {
      const intent=cardFocusIntent(key,cardFocus,cards.length>0);
      if(intent==='enter'||intent==='leave'){key.preventDefault();key.stopPropagation();setCardFocus(intent==='enter');if(intent==='enter')editor.current?.blur();return;}
      if(cardFocus){
        key.preventDefault();key.stopPropagation();
        if(intent==='card'){setCardIndex(Math.max(0,Math.min(cards.length-1,cardIndex+(key.name==='down'?1:-1))));setOption(0);}
        if(intent==='option')setOption(Math.max(0,Math.min((cards[cardIndex]?.card.actions?.length??1)-1,option+(key.name==='right'?1:-1))));
        if(intent==='act')selectedCardAction();
        return;
      }
      return;
    }
    if(key.name==='tab'&&cards.length){key.preventDefault();setView(view==='cards'?'conversation':'cards');return;}
    if(view==='cards'){
      key.preventDefault();
      if(key.name==='down'||key.name==='up'){setCardIndex(Math.max(0,Math.min(cards.length-1,cardIndex+(key.name==='down'?1:-1))));setOption(0);}
      if(key.name==='left'||key.name==='right')setOption(Math.max(0,Math.min((cards[cardIndex]?.card.actions?.length??1)-1,option+(key.name==='right'?1:-1))));
      if(isEnterKeyName(key.name))selectedCardAction();
    }
  });
  const recordReader=useMemo(()=>createProjectReadState(),[snapshot.workspaceId]);
  const records=view==='objectives'?recordReader.read<any>('objectives',()=>host.objectives.list({}, {workspaceId:snapshot.workspaceId,conversationId:host.profiles.read(snapshot.workspaceId)?.agentConversationId} as never) as any)
    :view==='memory'?recordReader.read<any>('memory',()=>host.memory.list({workspaceId:snapshot.workspaceId})):null;
  const rows:string[]=view==='tasks'?snapshot.sessions.map((row,index)=>`${index+1}. ${terminalText(row.title)} · ${projectStatus(locale,row.status)} · /task ${index+1}`)
    :view==='diagnostics'?snapshot.messages.flatMap(message=>(message.cards??[]).filter(isRecoveryCard).map((card:any)=>`${terminalText(card.cardId)}\n${terminalText(card.content)}`))
    :view==='memory'?(records?.rows??[]).map((row:any)=>`${projectStatus(locale,row.kind)} · ${projectStatus(locale,row.trust)} · ${projectStatus(locale,row.status)}\n${terminalText(row.text)}`)
    :view==='objectives'?(records?.rows??[]).map((row:any)=>`${terminalText(row.title)} · ${projectStatus(locale,row.status)}\n${terminalText(row.outcome??row.description??row.brief??'')}`)
    :view==='task'?[terminalText(detail?.title),projectStatus(locale,detail?.status??''),terminalText(detail?.report?.summary),...(detail?.report?.changedFiles??[]).map((row:any)=>terminalText(row.path)),...(detail?.report?.evidenceRefs??[]).map(terminalText)]:[];
  const currentCard=cards[Math.min(cardIndex,cards.length-1)];
  return <box flexDirection="column" height={terminal.height} width={terminal.width} backgroundColor={COLOR.background} padding={1}>
    <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
      <ThemedText fg={COLOR.accent}>Peer · {terminalText(bot?.profile.displayName??copy('bots'))} · {copy('botMode')}</ThemedText>
      <ThemedText fg={COLOR.link} onMouseDown={openClassic}>{copy('switchClassic')}</ThemedText>
      <ThemedText fg={COLOR.muted}>{snapshot.workspaceId?snapshot.isHost?copy('host'):copy('client'):''}</ThemedText>
    </box>
    {snapshot.messageState==='unavailable'?<ThemedText fg={COLOR.info}>{copy('messageUnavailable')}</ThemedText>:null}
    {snapshot.cardsUnavailable?<ThemedText fg={COLOR.muted}>{copy('cardsUnavailable')}</ThemedText>:null}
    {view==='bind'?<box flexGrow={1} flexDirection="column" justifyContent="center"><ThemedText fg={COLOR.text}>{copy('bind')}</ThemedText><ThemedText fg={COLOR.muted}>{terminalText(workspacePath)}</ThemedText><ThemedText fg={bindYes?COLOR.accent:COLOR.muted}>{copy('yes')} [Y]</ThemedText><ThemedText fg={!bindYes?COLOR.accent:COLOR.muted}>{copy('no')} [N]</ThemedText></box>
      :view==='bots'?<BotListView bots={snapshot.bots} selected={selected} locale={locale} height={terminal.height}/>
      :view==='conversation'?<BotConversationView messages={displayedMessages} cards={cards} locale={locale} isHost={snapshot.isHost} selectedCard={cardIndex} option={option} cardFocus={cardFocus}/>
      :view==='cards'?<box flexDirection="column" flexGrow={1}><ThemedText fg={COLOR.textSoft}>{copy('cards')} · {cards.length}</ThemedText>{currentCard?<CardLine row={currentCard} locale={locale} isHost={snapshot.isHost} selected option={option}/>:<ThemedText fg={COLOR.muted}>{copy('empty')}</ThemedText>}<ThemedText fg={COLOR.muted}>{copy('cardKeys')}</ThemedText></box>
      :<scrollbox flexGrow={1}><ThemedText fg={COLOR.textSoft}>{view==='help'?copy('help'):projectStatus(locale,view)}</ThemedText>{records?.error?<ThemedText fg={COLOR.info}>{copy('recordsUnavailable')}</ThemedText>:null}{rows.length?rows.map((row,index)=><ThemedText key={index} selectable fg={COLOR.text} marginBottom={1}>{row}</ThemedText>):view!=='help'&&!records?.error?<ThemedText fg={COLOR.muted}>{copy('empty')}</ThemedText>:null}</scrollbox>}
    <ThemedText fg={COLOR.info}>{notice}</ThemedText>
    {snapshot.workspaceId?<InputRecoveryStatus state={inputDraft.state} locale={locale}/>:null}
    {!['bind','bots','cards'].includes(view)?<box flexDirection="column" border borderColor={COLOR.border} paddingX={1}>
      <ThemedTextarea ref={editor} focused={!busy&&!cardFocus&&inputDraft.state.ready} height={3} placeholder={copy('composer')} wrapMode="char" onContentChange={()=>{if(inputDraft.state.ready)inputDraft.changed();}} onKeyDown={event=>{
        if(busy||!inputDraft.state.ready){event.preventDefault();event.stopPropagation();return;}
        const action=composerEnterAction({keyName:event.name,shift:event.shift,eventType:event.eventType,isComposing:(event as {isComposing?:boolean}).isComposing});
        if(action==='none')return;event.preventDefault();event.stopPropagation();
        if(action==='suppress')return;if(action==='newline'){editor.current?.newLine();return;}
        const text=editor.current?.plainText??'';if(text.trim()){
          submit(text);
        }
      }}/>
      <ThemedText fg={COLOR.muted}>/help · {copy('switchHint')} · {earlier?copy('earlier'):copy('latest')}</ThemedText>
      {cards.length?<ThemedText fg={COLOR.muted}>/cards · {copy('cardKeys')}</ThemedText>:null}
    </box>:null}
  </box>;
}
