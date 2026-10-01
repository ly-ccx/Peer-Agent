import {ThemedText} from '../themed-primitives.tsx';
import {COLOR} from '../tui-theme.ts';
import type {TuiLocale} from '../tui-language.ts';
import {projectCopy} from './project-copy.ts';
import {terminalText} from './commands.ts';
export function BotListView({bots,selected,locale,height}:{bots:readonly any[];selected:number;locale:TuiLocale;height:number}) {
  const size=Math.max(1,Math.floor((height-7)/3)),start=Math.max(0,Math.min(selected-Math.floor(size/2),bots.length-size));
  return <box flexDirection="column" flexGrow={1}>
    <ThemedText fg={COLOR.textSoft}>{projectCopy(locale,'bots')} · {bots.length}</ThemedText>
    {!bots.length?<ThemedText fg={COLOR.muted}>{projectCopy(locale,'empty')}</ThemedText>:null}
    {bots.slice(start,start+size).map((bot,index)=><box key={bot.workspaceId} flexDirection="column" paddingX={1} paddingY={0} backgroundColor={start+index===selected?COLOR.selection:COLOR.background}>
      <ThemedText fg={start+index===selected?COLOR.accent:COLOR.text}>{terminalText(bot.profile?.displayName)} · {projectCopy(locale,'cards')} {bot.state?.needsYou??0} · {projectCopy(locale,'running')} {bot.state?.running??0}</ThemedText>
      <ThemedText fg={COLOR.muted}>{terminalText(bot.lastMessagePreview ?? bot.preview ?? '')}  {terminalText(bot.lastActiveAt??'').slice(0,16)}</ThemedText>
      <ThemedText>{' '}</ThemedText>
    </box>)}
    <ThemedText fg={COLOR.muted}>{projectCopy(locale,'select')}</ThemedText>
  </box>;
}
