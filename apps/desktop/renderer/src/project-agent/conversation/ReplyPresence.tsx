import { useEffect, useState } from 'react';
import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import { ReplyContext } from './ReplyContext';
import type { BotReplyRow } from '../state/botReplyContinuity';
import { isActivityRunning } from '../state/botActivityState';
import '../styles/bot-reply-presence.css';

/** Elapsed time changes reassurance only; it never declares a failure or schedules execution. */
export function ReplyPresence({ reply, i18n, onReload, onOpenDetails }: {
  readonly reply: BotReplyRow; readonly i18n: I18nRuntime;
  readonly onReload: () => void; readonly onOpenDetails?: () => void;
}) {
  const activity = reply.activity;
  const running = isActivityRunning(activity ?? null);
  const since = reply.pending?.since || activity?.startedAt || '';
  const waiting = running || Boolean(reply.pending && !reply.pending.sending && !reply.pending.restored && !reply.pending.deliveryIssue);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const start = Date.parse(since);
    if (!waiting || !Number.isFinite(start)) return;
    const remaining = Math.max(0, start + 15_000 - Date.now());
    if (!remaining) { setSlow(true); return; }
    const timer = setTimeout(() => setSlow(true), remaining);
    return () => clearTimeout(timer);
  }, [reply.id, since, waiting]);
  let key: TranslationKey | null = null;
  if (reply.stopping) key = 'projectAgent.chat.stopping';
  else if (activity?.phase === 'awaiting_permission') key = 'projectAgent.chat.activity.permission';
  else if (activity?.recovery) key = 'projectAgent.chat.reply.reconnecting';
  else if (reply.pending?.deliveryIssue) key = 'projectAgent.chat.reply.deliveryIssue';
  else if (reply.pending?.restored) key = 'projectAgent.chat.reply.unconfirmed';
  else if (slow && waiting) key = 'projectAgent.chat.reply.slow';
  else if (!reply.paragraphs.length) {
    key = reply.pending?.sending ? 'projectAgent.chat.sending'
      : activity?.phase === 'error' ? 'projectAgent.chat.reply.interrupted'
      : activity?.phase === 'stopped' ? 'projectAgent.chat.stopped'
      : activity?.phase === 'done' ? 'projectAgent.chat.reply.synchronizing'
      : slow ? 'projectAgent.chat.reply.slow' : 'projectAgent.chat.waiting';
  }
  if (reply.message && !running) key = null;
  const refresh = reply.pending?.restored || reply.pending?.deliveryIssue || slow && !activity || activity && !running;
  return <ReplyContext i18n={i18n} statusLabel={key ? i18n.t(key) : null}
    busy={Boolean(key && waiting && activity?.phase !== 'awaiting_permission')}
    onOpenDetails={onOpenDetails} onRefresh={refresh ? onReload : undefined} />;
}
