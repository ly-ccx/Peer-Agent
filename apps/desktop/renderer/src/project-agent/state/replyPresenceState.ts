import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import type { BotReplyRow } from './botReplyContinuity';
import { isActivityRunning } from './botActivityState.ts';
import { replyActivityLabel } from './replyActivityLabel.ts';

/** Receipt, activity and delivery are distinct facts. Time alone cannot change their meaning. */
export function replyPresenceState(reply: BotReplyRow, i18n: I18nRuntime) {
  const activity = reply.activity;
  const running = isActivityRunning(activity ?? null);
  if (reply.message && !running) return { label: null, busy: false, refresh: false };
  let key: TranslationKey | undefined;
  let label: string | null = null;
  let busy = false;
  if (reply.stopping) { key = 'projectAgent.chat.stopping'; busy = running; }
  else if (activity?.phase === 'awaiting_permission') key = 'projectAgent.chat.activity.permission';
  else if (running && activity?.recovery) { key = 'projectAgent.chat.reply.reconnecting'; busy = true; }
  else if (running) {
    // Public prose carries the progress once it exists; routine process stays in details.
    if (!reply.paragraphs.length) { label = replyActivityLabel(activity, i18n); busy = true; }
  } else if (activity?.phase === 'error') key = 'projectAgent.chat.reply.interrupted';
  else if (activity?.phase === 'stopped') key = 'projectAgent.chat.stopped';
  else if (activity?.phase === 'done') key = 'projectAgent.chat.reply.synchronizing';
  else if (reply.pending?.deliveryIssue) key = 'projectAgent.chat.reply.deliveryIssue';
  else if (reply.pending?.restored) key = 'projectAgent.chat.reply.unconfirmed';
  else if (reply.pending?.sending) { key = 'projectAgent.chat.sending'; busy = true; }
  else if (reply.pending) key = 'projectAgent.chat.reply.received';
  return { label: key ? i18n.t(key) : label, busy,
    refresh: !running && !reply.stopping && Boolean(activity || reply.pending && !reply.pending.sending) };
}
