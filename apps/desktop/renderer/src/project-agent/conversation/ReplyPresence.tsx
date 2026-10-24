import type { I18nRuntime } from '@peer-agent/i18n';
import { ReplyContext } from './ReplyContext';
import type { BotReplyRow } from '../state/botReplyContinuity';
import { replyPresenceState } from '../state/replyPresenceState';
import '../styles/bot-reply-presence.css';

/** One status/details entry projects the current reply facts. */
export function ReplyPresence({ reply, i18n, onReload, onOpenDetails }: {
  readonly reply: BotReplyRow; readonly i18n: I18nRuntime;
  readonly onReload: () => void; readonly onOpenDetails?: () => void;
}) {
  const state = replyPresenceState(reply, i18n);
  return <ReplyContext i18n={i18n} statusLabel={state.label} busy={state.busy}
    onOpenDetails={onOpenDetails} onRefresh={state.refresh ? onReload : undefined} />;
}
