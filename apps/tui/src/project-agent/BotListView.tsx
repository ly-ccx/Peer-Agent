import { ThemedText } from '../themed-primitives.tsx';
import { COLOR, PICKER_CHROME } from '../tui-theme.ts';
import type { TuiLocale } from '../tui-language.ts';
import { projectCopy } from './project-copy.ts';
import { terminalText } from './commands.ts';
import { clipBotLine, formatBotWhen } from './bot-list-format.ts';

export function BotListView({
  bots,
  selected,
  locale,
  height,
  width,
}: {
  bots: readonly any[];
  selected: number;
  locale: TuiLocale;
  height: number;
  width: number;
}) {
  const inner = Math.max(24, width);
  const rowHeight = 4;
  const size = Math.max(1, Math.floor((height - 6) / rowHeight));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), Math.max(0, bots.length - size)));
  const rule = PICKER_CHROME.separator.repeat(Math.min(inner, 72));
  return <box flexDirection="column" flexGrow={1}>
    <box flexDirection="row" justifyContent="space-between">
      <ThemedText fg={COLOR.text}>{projectCopy(locale, 'bots')}</ThemedText>
      <ThemedText fg={COLOR.muted}>{String(bots.length)}</ThemedText>
    </box>
    <ThemedText fg={COLOR.border}>{rule}</ThemedText>
    {!bots.length ? <ThemedText fg={COLOR.muted}>{projectCopy(locale, 'empty')}</ThemedText> : null}
    <box flexDirection="column" flexGrow={1}>
      {bots.slice(start, start + size).map((bot, index) => {
        const active = start + index === selected;
        const when = formatBotWhen(terminalText(bot.lastActiveAt ?? ''));
        const nameWidth = Math.max(8, inner - when.length - 4);
        const name = clipBotLine(terminalText(bot.profile?.displayName ?? ''), nameWidth);
        const preview = clipBotLine(terminalText(bot.lastMessagePreview ?? bot.preview ?? ''), Math.max(8, inner - 2));
        const needsYou = bot.state?.needsYou ?? 0;
        const running = bot.state?.running ?? 0;
        return <box key={bot.workspaceId} flexDirection="column" marginBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <ThemedText fg={active ? PICKER_CHROME.selectedForeground : PICKER_CHROME.idleForeground} wrapMode="none">
              {active ? PICKER_CHROME.caretSelected : PICKER_CHROME.caretIdle}{name}
            </ThemedText>
            <ThemedText fg={COLOR.muted} wrapMode="none">{when}</ThemedText>
          </box>
          <ThemedText fg={COLOR.muted} wrapMode="none">
            {`  ${projectCopy(locale, 'cards')} ${needsYou}    ${projectCopy(locale, 'running')} ${running}`}
          </ThemedText>
          <ThemedText fg={COLOR.textSoft} wrapMode="none">{preview ? `  ${preview}` : ' '}</ThemedText>
        </box>;
      })}
    </box>
    <box border={['top']} borderColor={COLOR.border} paddingTop={0}>
      <ThemedText fg={COLOR.muted}>{projectCopy(locale, 'select')}</ThemedText>
    </box>
  </box>;
}
