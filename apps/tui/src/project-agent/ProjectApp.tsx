import {useEffect,useRef,useState} from 'react';
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

type Host=ReturnType<typeof createTuiProjectHost>;
type Client=ReturnType<typeof createTuiProjectClient>;
type View='bind'|'bots'|'conversation'|'tasks'|'task'|'memory'|'objectives'|'cards'|'help';
export function ProjectApp({host,client,initialView,workspacePath,locale,themeStore,onClassic,onQuit}:{host:Host;client:Client;initialView:'bind'|'bots'|'conversation';workspacePath:string;locale:TuiLocale;themeStore:TuiThemeStore;onClassic():Promise<void>;onQuit():void}) {
  const terminal=useTerminalDimensions(), editor=useRef<TextareaRenderable|null>(null),numbers=useRef(createCardNumbers());
  const [snapshot,setSnapshot]=useState(()=>client.poll()),[view,setView]=useState<View>(initialView),[selected,setSelected]=useState(0);
  const [cardIndex,setCardIndex]=useState(0),[option,setOption]=useState(0),[bindYes,setBindYes]=useState(true),[detail,setDetail]=useState<any>(null);
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[earlier,setEarlier]=useState(false),[,setTheme]=useState(themeStore.getState());
  const copy=(key:Parameters<typeof projectCopy>[1])=>projectCopy(locale,key);
  const offer=snapshot.familiarizeOffer;
  const displayedMessages=offer?[...snapshot.messages,{id:`offer:${snapshot.workspaceId}`,kind:'system_card',cards:[{
    cardId:`offer:familiarize:${snapshot.workspaceId}`,kind:'familiarize',content:copy('familiarizeQuestion'),
    actions:[{id:'familiarize',channel:'project-agent:start-familiarize',payload:{}}],
  }]}]:snapshot.messages;
  const cards=numbers.current.project(snapshot.workspaceId,displayedMessages);
  const bot=snapshot.bots.find(row=>row.workspaceId===snapshot.workspaceId);
  const refresh=()=>setSnapshot(client.poll(true));
  useEffect(()=>{const timer=setInterval(()=>setSnapshot(client.poll()),1000);return()=>clearInterval(timer);},[client]);
  useEffect(()=>themeStore.subscribe(setTheme),[themeStore]);
  useEffect(()=>{if(!['bind','bots','cards'].includes(view))queueMicrotask(()=>editor.current?.focus());},[view]);
  const lastId=snapshot.messages.filter(row=>['user_input','agent_reply','system_card'].includes(row.kind)).at(-1)?.id;
  useEffect(()=>{if(view==='conversation'&&!earlier&&snapshot.workspaceId)host.directory.markRead(snapshot.workspaceId);},[lastId,snapshot.workspaceId,view,earlier]);
  async function perform(run:()=>Promise<any>|any) {
    if(busy)return;
    setBusy(true);
    try {const result=await run();if(result?.ok===false){setNotice(result.error==='desktop_approval_required'?copy('desktop'):`${copy('error')}: ${terminalText(result.error??result.code??'')}`);}else setNotice(copy('done'));refresh();}
    catch {setNotice(copy('error'));}
    finally {setBusy(false);}
  }
  async function openBot(index:number) {
    const selectedBot=snapshot.bots[index];if(!selectedBot)return;
    await perform(async()=>{setSnapshot(await client.select(selectedBot.workspaceId));setView('conversation');setEarlier(false);});
  }
  function submit(text:string) {
    const command=parseProjectCommand(text);
    if(command.kind==='text'){if(command.text)perform(()=>{client.latest();client.submit(command.text);setEarlier(false);setView('conversation');return {ok:true};});return;}
    if(command.kind==='invalid'){setNotice(copy('invalid'));return;}
    if(command.kind==='view'){setView(command.view);setSelected(0);setCardIndex(0);setOption(0);return;}
    if(command.kind==='classic'){setNotice(copy('leaving'));void perform(onClassic);return;}
    if(command.kind==='takeover'){void perform(async()=>{await host.takeover();setNotice(copy('takeover'));});return;}
    if(command.kind==='older'){setSnapshot(client.earlier());setEarlier(true);setView('conversation');return;}
    if(command.kind==='latest'){setSnapshot(client.latest());setEarlier(false);setView('conversation');return;}
    if(command.kind==='help'){setView('help');return;}
    if(command.kind==='task'){
      const session=snapshot.sessions[command.number-1];if(!session){setNotice(copy('invalid'));return;}
      setDetail(host.supervisor.get({sessionId:session.sessionId,detail:'report'}));setView('task');return;
    }
    if(command.kind!=='card')return;
    const action=cardAction(command,cards);
    if(!action){setNotice(copy('invalid'));return;}
    void perform(()=>runProjectCardAction(host,client,action));
  }
  function selectedCardAction() {
    const row=cards[Math.min(cardIndex,cards.length-1)],action=row?.card.actions?.[option];
    if(!row||!action)return;
    if(action.id==='answer'&&!action.payload?.text){setView('conversation');queueMicrotask(()=>editor.current?.setText(`/answer ${row.number} `));return;}
    void perform(()=>runProjectCardAction(host,client,action));
  }
  useKeyboard(key=>{
    if(key.ctrl&&key.name==='c'){key.preventDefault();setNotice(copy('leaving'));onQuit();return;}
    if(busy)return;
    if(key.name==='escape'){key.preventDefault();if(view==='bind')void perform(onClassic);else setView('conversation');return;}
    if(view==='bind'){
      if(['left','right','up','down','tab'].includes(key.name)){key.preventDefault();setBindYes(!bindYes);}
      if(['y','n','enter','return'].includes(key.name)){
        key.preventDefault();const accept=key.name==='y'||(['enter','return'].includes(key.name)&&bindYes);
        if(!accept){void perform(onClassic);return;}
        void perform(async()=>{const entry=host.registry.ensureForPath(workspacePath);const created=host.lifecycle.ensureBot(entry.workspaceId) as any;
          if(!created.ok)return created;if(created.profile.status==='archived')host.lifecycle.restoreBot(entry.workspaceId);
          setSnapshot(await client.select(entry.workspaceId));setView('conversation');return {ok:true};});
      }return;
    }
    if(view==='bots'){
      if(key.name==='down'||key.name==='up'){key.preventDefault();setSelected(Math.max(0,Math.min(snapshot.bots.length-1,selected+(key.name==='down'?1:-1))));}
      if(key.name==='enter'||key.name==='return'){key.preventDefault();void openBot(selected);}return;
    }
    if(key.name==='tab'&&cards.length){key.preventDefault();setView(view==='cards'?'conversation':'cards');return;}
    if(view==='cards'){
      key.preventDefault();
      if(key.name==='down'||key.name==='up'){setCardIndex(Math.max(0,Math.min(cards.length-1,cardIndex+(key.name==='down'?1:-1))));setOption(0);}
      if(key.name==='left'||key.name==='right')setOption(Math.max(0,Math.min((cards[cardIndex]?.card.actions?.length??1)-1,option+(key.name==='right'?1:-1))));
      if(key.name==='enter'||key.name==='return')selectedCardAction();
    }
  });
  const objectiveResult=view==='objectives'?host.objectives.list({}, {workspaceId:snapshot.workspaceId,conversationId:host.profiles.read(snapshot.workspaceId)?.agentConversationId} as never) as any:null;
  const rows:string[]=view==='tasks'?snapshot.sessions.map((row,index)=>`${index+1}. ${terminalText(row.title)} · ${projectStatus(locale,row.status)} · /task ${index+1}`)
    :view==='memory'?host.memory.list({workspaceId:snapshot.workspaceId}).map((row:any)=>`${projectStatus(locale,row.kind)} · ${projectStatus(locale,row.trust)} · ${projectStatus(locale,row.status)}\n${terminalText(row.text)}`)
    :view==='objectives'?(objectiveResult?.items??[]).map((row:any)=>`${terminalText(row.title)} · ${projectStatus(locale,row.status)}\n${terminalText(row.description??row.brief??'')}`)
    :view==='task'?[terminalText(detail?.title),projectStatus(locale,detail?.status??''),terminalText(detail?.report?.summary),...(detail?.report?.changedFiles??[]).map((row:any)=>terminalText(row.path)),...(detail?.report?.evidenceRefs??[]).map(terminalText)]:[];
  const currentCard=cards[Math.min(cardIndex,cards.length-1)];
  return <box flexDirection="column" height={terminal.height} width={terminal.width} backgroundColor={COLOR.background} padding={1}>
    <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
      <ThemedText fg={COLOR.accent}>Peer · {terminalText(bot?.profile.displayName??copy('bots'))}</ThemedText>
      <ThemedText fg={COLOR.muted}>{snapshot.workspaceId?snapshot.isHost?copy('host'):copy('client'):''}</ThemedText>
    </box>
    {view==='bind'?<box flexGrow={1} flexDirection="column" justifyContent="center"><ThemedText fg={COLOR.text}>{copy('bind')}</ThemedText><ThemedText fg={COLOR.muted}>{terminalText(workspacePath)}</ThemedText><ThemedText fg={bindYes?COLOR.accent:COLOR.muted}>{copy('yes')} [Y]</ThemedText><ThemedText fg={!bindYes?COLOR.accent:COLOR.muted}>{copy('no')} [N]</ThemedText></box>
      :view==='bots'?<BotListView bots={snapshot.bots} selected={selected} locale={locale} height={terminal.height}/>
      :view==='conversation'?<BotConversationView messages={displayedMessages} cards={cards} locale={locale} isHost={snapshot.isHost} selectedCard={cardIndex} option={option} cardFocus={false}/>
      :view==='cards'?<box flexDirection="column" flexGrow={1}><ThemedText fg={COLOR.textSoft}>{copy('cards')} · {cards.length}</ThemedText>{currentCard?<CardLine row={currentCard} locale={locale} isHost={snapshot.isHost} selected option={option}/>:<ThemedText fg={COLOR.muted}>{copy('empty')}</ThemedText>}<ThemedText fg={COLOR.muted}>{copy('cardKeys')}</ThemedText></box>
      :<scrollbox flexGrow={1}><ThemedText fg={COLOR.textSoft}>{view==='help'?copy('help'):projectStatus(locale,view)}</ThemedText>{rows.length?rows.map((row,index)=><ThemedText key={index} selectable fg={COLOR.text} marginBottom={1}>{row}</ThemedText>):view!=='help'?<ThemedText fg={COLOR.muted}>{copy('empty')}</ThemedText>:null}</scrollbox>}
    <ThemedText fg={COLOR.info}>{notice}</ThemedText>
    {!['bind','bots','cards'].includes(view)?<box flexDirection="column" border borderColor={COLOR.border} paddingX={1}>
      <ThemedTextarea ref={editor} focused={!busy} height={3} placeholder={copy('composer')} wrapMode="char" onKeyDown={event=>{
        if(!['enter','return'].includes(event.name)||event.eventType!=='press')return;
        event.preventDefault();event.stopPropagation();if(event.shift){editor.current?.newLine();return;}
        const text=editor.current?.plainText??'';if(text.trim()){editor.current?.clear();submit(text);}
      }}/>
      <ThemedText fg={COLOR.muted}>/help · {earlier?copy('earlier'):copy('latest')} · {copy('cardKeys')}</ThemedText>
    </box>:null}
  </box>;
}
