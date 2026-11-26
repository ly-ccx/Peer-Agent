import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { isExecutionTicking, taskExecutionLabel, taskExecutionTitle, type TaskExecutionTiming } from './state/taskExecutionDuration.ts';

interface Props {
  readonly surface: 'header' | 'sidebar';
  readonly timing: TaskExecutionTiming;
  readonly i18n: I18nRuntime;
}

function DurationLabel({ surface, timing, i18n, now, title }: Props & { now: number; title?: string }) {
  const text = taskExecutionLabel(timing, surface, now, i18n);
  if (!text) return null;
  return (
    <span className={surface === 'header' ? 'bot-task-strip-duration' : 'bot-sidebar-task-duration'} title={title}>
      {text}
    </span>
  );
}

function LiveExecutionDuration(props: Props & { title?: string }) {
  const [now, setNow] = useState(Date.now);
  const intervalMs = props.surface === 'header' ? 1000 : 15000;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return <DurationLabel {...props} now={now} />;
}

export function TaskExecutionDuration(props: Props) {
  const { surface, timing, i18n } = props;
  const title = surface === 'header' ? taskExecutionTitle(timing, i18n) : undefined;
  return isExecutionTicking(timing)
    ? <LiveExecutionDuration key={timing.startedAt} {...props} title={title} />
    : <DurationLabel {...props} now={0} title={title} />;
}
