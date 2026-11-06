import type { I18nRuntime, TranslationKey } from '@peer-agent/i18n';
import type { BotReplyRow } from './botReplyContinuity';
import { isActivityRunning } from './botActivityState.ts';

interface ReplyPresenceView {
  readonly label: string | null;
  readonly busy: boolean;
  readonly refresh: boolean;
  readonly replying?: boolean;
}

/** Receipt, activity and delivery are distinct facts. Time alone cannot change their meaning. */
export function replyPresenceState(reply: BotReplyRow, i18n: I18nRuntime): ReplyPresenceView {
  // The shared recovery banner owns this blocked state. Retain process facts without a stale spinner.
  if (reply.recovery) return { label: null, busy: false, refresh: false };
  const activity = reply.activity;
  const running = isActivityRunning(activity ?? null);
  if (reply.message && !running) return { label: null, busy: false, refresh: false };
  let key: TranslationKey | undefined;
  let busy = false;
  if (reply.stopping) { key = 'projectAgent.chat.stopping'; busy = running; }
  else if (activity?.phase === 'awaiting_permission') key = 'projectAgent.chat.activity.permission';
  else if (running && activity?.recovery) { key = 'projectAgent.chat.reply.reconnecting'; busy = true; }
  else if (running) {
    // One stable cue spans provider, prose and tool stages; details own the process.
    return { label: i18n.t('projectAgent.chat.generating'), busy: true, refresh: false, replying: true };
  } else if (activity?.phase === 'error') key = 'projectAgent.chat.reply.interrupted';
  else if (activity?.phase === 'stopped') key = 'projectAgent.chat.stopped';
  else if (activity?.phase === 'done') {
    // Delivery handoff keeps the same cue, with static dots after execution ends.
    return { label: i18n.t('projectAgent.chat.generating'), busy: false, refresh: false, replying: true };
  }
  else if (reply.pending?.deliveryIssue) key = 'projectAgent.chat.reply.deliveryIssue';
  else if (reply.pending?.restored) key = 'projectAgent.chat.reply.unconfirmed';
  else if (reply.pending?.sending) { key = 'projectAgent.chat.sending'; busy = true; }
  // The user's message owns its receipt. It is neither a running reply nor footer copy.
  return { label: key ? i18n.t(key) : null, busy,
    refresh: !running && !reply.stopping && Boolean(activity || reply.pending && !reply.pending.sending
      && (reply.pending.restored || reply.pending.deliveryIssue)) };
}
