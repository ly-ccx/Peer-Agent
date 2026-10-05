import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity, ProjectAgentToolPreview } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { agentProcessEntries, toolPresentation } from '../drawer/agentProcess';
import type { BotToolRound } from '../state/botConversationState';
import { isActivityRunning } from '../state/botActivityState';
import '../styles/bot-process.css';

export interface ProcessDisclosure {
  readonly open: Readonly<Record<string, boolean>>;
  readonly toggle: (key: string, open: boolean) => void;
}

/** Presentation of actual TurnSink events or persisted rounds; no execution or retrieval. */
export function BotProcess({ activity, rounds = [], i18n, disclosure, outcome }: {
  readonly activity?: ProjectAgentActivity;
  readonly rounds?: readonly BotToolRound[];
  readonly i18n: I18nRuntime;
  readonly disclosure?: ProcessDisclosure;
  readonly outcome?: 'stopped' | 'error';
}) {
  const running = isActivityRunning(activity ?? null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, activity?.turnId]);
  const entries = activity ? activity.segments.flatMap(segment => segment.kind === 'tool' ? [{
    ...segment, ...toolPresentation(segment.name), input: segment.input, result: segment.result,
  }] : []) : agentProcessEntries(rounds).filter(entry => entry.name !== 'post_reply').map((entry, index) => ({
    ...entry, status: entry.status === 'unknown' && outcome ? outcome === 'stopped' ? 'stopped' as const : 'failed' as const : entry.status,
    id: String(index), startedAt: undefined, finishedAt: undefined, receivedChars: undefined,
    input: entry.inputPreview, result: entry.resultPreview,
  }));
  const current = [...entries].reverse().find(entry => ['preparing', 'running'].includes(entry.status));
  const elapsed = activity ? secondsBetween(activity.startedAt, activity.finishedAt, now) : null;
  if (!entries.length && !running) return null;
  const label = current ? i18n.t(current.status === 'preparing' ? 'projectAgent.process.preparingTitle' : 'projectAgent.process.runningTitle', { tool: i18n.t(current.labelKey) }) : i18n.t(running
    ? entries.length ? 'projectAgent.process.organizing' : 'projectAgent.process.preparingReply'
    : (activity?.phase ?? outcome) === 'stopped' ? 'projectAgent.process.stopped'
      : (activity?.phase ?? outcome) === 'error' ? 'projectAgent.process.failed' : 'projectAgent.chat.process');
  return <details className="bot-turn-process" data-running={running} open={disclosure?.open.main}
    onToggle={event => disclosure?.toggle('main', event.currentTarget.open)}>
    <summary className="bot-turn-process-heading">
      <span className={`bot-process-current${running ? ' is-running' : ''}`}>
        {current ? <PeerIcon name={current.icon} size={14} /> : null}
        <span>{label}{current?.summary ? <span className="bot-process-target"> {current.summary}</span> : null}</span>
      </span>
      {elapsed !== null ? <span className="bot-process-elapsed" aria-hidden="true">{duration(elapsed, i18n)}</span> : null}
      <PeerIcon name="chevronDown" size={12} />
    </summary>
    <div className="bot-turn-process-content">
      {!entries.length ? <p className="bot-process-note">{i18n.t('projectAgent.process.awaitingContent')}</p> : null}
      {entries.map((entry, index) => {
        const active = ['preparing', 'running'].includes(entry.status);
        const time = secondsBetween(entry.startedAt, entry.finishedAt, now);
        const status = entry.status === 'error' ? 'failed' : entry.status;
        return <details className="bot-tool-step" data-status={entry.status} key={entry.id} open={disclosure?.open[`step-${index}`]}
          onToggle={event => { event.stopPropagation(); disclosure?.toggle(`step-${index}`, event.currentTarget.open); }}>
          <summary>
            <PeerIcon name={entry.icon} size={14} />
            <span className={`bot-tool-step-label${active ? ' is-running' : ''}`}>{i18n.t(entry.labelKey)}
              {entry.summary ? <span className="bot-process-target"> {entry.summary}</span> : null}</span>
            <span className="bot-tool-step-status">{i18n.t(`projectAgent.process.${status}`)}</span>
            {time !== null ? <span className="bot-process-elapsed" aria-hidden="true">{duration(time, i18n)}</span> : null}
            <PeerIcon name="chevronRight" size={12} />
          </summary>
          <div className="bot-tool-step-content">
            {entry.receivedChars !== undefined && entry.status === 'preparing' ? <p className="bot-process-note">{i18n.t('projectAgent.process.receiving', { count: entry.receivedChars })}</p> : null}
            {active ? <p className="bot-process-note">{i18n.t(entry.status === 'preparing' ? 'projectAgent.process.preparingNote' : 'projectAgent.process.runningNote')}</p> : null}
            <Preview label={i18n.t('projectAgent.process.parameters')} value={entry.input} i18n={i18n} disclosure={disclosure} slot={`input-${index}`} />
            <Preview label={i18n.t('projectAgent.process.output')} value={entry.result} i18n={i18n} disclosure={disclosure} slot={`result-${index}`} />
            <details className="bot-tool-metadata" open={disclosure?.open[`metadata-${index}`]}
              onToggle={event => { event.stopPropagation(); disclosure?.toggle(`metadata-${index}`, event.currentTarget.open); }}>
              <summary><PeerIcon name="chevronRight" size={12} />{i18n.t('projectAgent.process.technical')}</summary><code>{entry.name}</code>
            </details>
          </div>
        </details>;
      })}
    </div>
  </details>;
}

function Preview({ label, value, i18n, disclosure, slot }: { readonly label: string; readonly value?: ProjectAgentToolPreview; readonly i18n: I18nRuntime; readonly disclosure?: ProcessDisclosure; readonly slot: string }) {
  if (!value) return null;
  return <details className="bot-tool-preview" open={disclosure?.open[slot]} onToggle={event => { event.stopPropagation(); disclosure?.toggle(slot, event.currentTarget.open); }}><summary><PeerIcon name="chevronRight" size={12} />{label}
    {value.truncated ? <span>{i18n.t('projectAgent.process.truncated')}</span> : null}
    {value.redacted ? <span>{i18n.t('projectAgent.process.redacted')}</span> : null}
  </summary><pre tabIndex={0}>{value.text || i18n.t('projectAgent.process.previewLimit')}</pre></details>;
}

function secondsBetween(start: string | undefined, end: string | undefined, now: number): number | null {
  const first = Date.parse(start ?? ''), last = end ? Date.parse(end) : now;
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, Math.floor((last - first) / 1000)) : null;
}
function duration(seconds: number, i18n: I18nRuntime): string {
  return i18n.t(seconds < 60 ? 'projectAgent.process.seconds' : 'projectAgent.process.minutes', { seconds: seconds % 60, minutes: Math.floor(seconds / 60) });
}
