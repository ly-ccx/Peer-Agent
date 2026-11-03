import { useEffect, useState } from 'react';
import { ThemedText } from '../themed-primitives.tsx';
import { COLOR } from '../tui-theme.ts';
import type { TuiLocale } from '../tui-language.ts';
import { projectCopy } from './project-copy.ts';
import { terminalText } from './commands.ts';
import type { createTuiProjectHost } from './tui-project-host.ts';

type Host = Pick<ReturnType<typeof createTuiProjectHost>, 'readTaskResult'>;

export function TaskResultText({ host, sessionId, reference, locale }: {
  host: Host; sessionId: string; reference: string; locale: TuiLocale;
}) {
  type Result = Awaited<ReturnType<Host['readTaskResult']>>;
  const [result, setResult] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void host.readTaskResult(sessionId, reference, controller.signal).then(
      value => { if (!controller.signal.aborted) setResult(value); },
      () => { if (!controller.signal.aborted) setFailed(true); },
    );
    return () => controller.abort();
  }, [host, reference, sessionId]);
  const copy = (key: Parameters<typeof projectCopy>[1]) => projectCopy(locale, key);
  if (!result) return <ThemedText fg={COLOR.info}>{copy(failed ? 'resultReadFailed' : 'resultLoading')}</ThemedText>;
  const { summary, computation, computationUnavailable } = result;
  return <box flexDirection="column" marginTop={1}>
    <ThemedText fg={COLOR.textSoft}>{terminalText(summary.title)}</ThemedText>
    {summary.availability === 'cleaned' ? <ThemedText fg={COLOR.info}>{copy('resultCleaned')}</ThemedText> : null}
    <ThemedText fg={COLOR.muted}>{copy('resultSummary')}</ThemedText>
    <ThemedText fg={COLOR.text} selectable>{terminalText(summary.textFallback)}</ThemedText>
    {summary.truncated ? <ThemedText fg={COLOR.muted}>{copy('resultTruncated')}</ThemedText> : null}
    {computation ? <>
      <ThemedText fg={COLOR.muted}>{copy('resultInitial')}</ThemedText>
      <ThemedText fg={COLOR.text} selectable>{terminalText(computation.text)}</ThemedText>
      {computation.truncated ? <ThemedText fg={COLOR.muted}>{copy('resultTruncated')}</ThemedText> : null}
    </> : computationUnavailable ? <ThemedText fg={COLOR.info}>{copy('resultProjectionFailed')}</ThemedText> : null}
    <ThemedText fg={COLOR.muted} selectable>{`${summary.ref}\n${summary.source.conversationId} / ${summary.source.toolCallId}`}</ThemedText>
  </box>;
}
