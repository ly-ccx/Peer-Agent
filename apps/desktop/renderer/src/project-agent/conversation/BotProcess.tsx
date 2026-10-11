import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity, ProjectAgentToolPreview } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { agentProcessEntries, toolPresentation, toolPreviewText, toolStepStatus } from '../drawer/agentProcess';
import type { BotToolRound } from '../state/botConversationState';
import { isActivityRunning } from '../state/botActivityState';
import { processSeconds, processDuration } from '../state/processDuration.ts';
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
    ...entry,
    id: String(index), receivedChars: undefined,
    input: entry.inputPreview, result: entry.resultPreview,
  }));
  const current = [...entries].reverse().find(entry => ['preparing', 'running'].includes(entry.status));
  const elapsed = activity ? processSeconds(activity.startedAt, activity.finishedAt, now) : null;
  if (!entries.length && !running) return null;
  const label = current ? i18n.t(current.status === 'preparing' ? 'projectAgent.process.preparingTitle' : 'projectAgent.process.runningTitle', { tool: i18n.t(current.labelKey) }) : i18n.t(running
    ? entries.length ? 'projectAgent.process.organizing' : 'projectAgent.process.preparingReply'
    : (activity?.phase ?? outcome) === 'stopped' ? 'projectAgent.process.stopped'
      : (activity?.phase ?? outcome) === 'error' ? 'projectAgent.process.failed' : 'projectAgent.process.done');
  return <details className="bot-turn-process" data-running={running} open={disclosure?.open.main}
    onToggle={event => disclosure?.toggle('main', event.currentTarget.open)}>
    <summary className="bot-turn-process-heading">
      <span className="bot-process-overview">
        <span className="bot-process-caption">{i18n.t('projectAgent.process.heading')}
          {entries.length ? <span className="bot-process-count">{i18n.t('projectAgent.process.steps', { count: entries.length })}</span> : null}
        </span>
        <span className={`bot-process-current${running ? ' is-running' : ''}`}>{label}</span>
        {current?.summary ? <span className="bot-process-target" title={current.summary}>{current.summary}</span> : null}
      </span>
      {elapsed !== null ? <span className="bot-process-elapsed" aria-hidden="true">{processDuration(elapsed, i18n)}</span> : null}
      <PeerIcon name="chevronDown" size={12} />
    </summary>
    <div className="bot-turn-process-content">
      {!entries.length ? <p className="bot-process-note">{i18n.t('projectAgent.process.awaitingContent')}</p> : null}
      {entries.map((entry, index) => {
        const active = ['preparing', 'running'].includes(entry.status);
        const time = processSeconds(entry.startedAt, entry.finishedAt, now, !active);
        const status = toolStepStatus(entry.status, entry.result, outcome);
        return <details className="bot-tool-step" data-status={entry.status} key={entry.id} open={disclosure?.open[`step-${index}`]}
          onToggle={event => { event.stopPropagation(); disclosure?.toggle(`step-${index}`, event.currentTarget.open); }}>
          <summary>
            <span className="bot-tool-step-icon"><PeerIcon name={entry.icon} size={15} /></span>
            <span className="bot-tool-step-copy"><span className={`bot-tool-step-label${active ? ' is-running' : ''}`}>{i18n.t(entry.labelKey)}</span>
              {entry.summary ? <span className="bot-process-target" title={entry.summary}>{entry.summary}</span> : null}</span>
            <span className="bot-tool-step-meta"><span className="bot-tool-step-status">{i18n.t(`projectAgent.process.${status}`)}</span>
              {time !== null ? <span className="bot-process-elapsed" aria-hidden="true">{processDuration(time, i18n)}</span> : null}</span>
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
  const text = toolPreviewText(value, {
    empty: i18n.t('projectAgent.process.noOutput'),
    limit: i18n.t('projectAgent.process.previewLimit'),
  });
  return <details className="bot-tool-preview" open={disclosure?.open[slot]} onToggle={event => { event.stopPropagation(); disclosure?.toggle(slot, event.currentTarget.open); }}><summary><PeerIcon name="chevronRight" size={12} />{label}
    {value.truncated ? <span>{i18n.t('projectAgent.process.truncated')}</span> : null}
    {value.redacted ? <span>{i18n.t('projectAgent.process.redacted')}</span> : null}
  </summary><pre tabIndex={0}>{text}</pre></details>;
}
