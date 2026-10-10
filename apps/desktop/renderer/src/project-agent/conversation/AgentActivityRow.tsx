import type { AgentActivity } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { agentIdentityTone } from '../state/agentActivityState';

export function AgentActivityRow({ messageId, activity, i18n, onOpen }: {
  readonly messageId: string;
  readonly activity: AgentActivity;
  readonly i18n: I18nRuntime;
  readonly onOpen: (sessionId: string) => void;
}) {
  return <button type="button" id={`bot-msg-${messageId}`} className="bot-agent-activity" data-agent-state={activity.state}
    onClick={() => onOpen(activity.sessionId)} title={i18n.t('projectAgent.chat.agent.open')}>
    <span className="bot-agent-marker" data-tone={agentIdentityTone(activity.sessionId)}><PeerIcon name="blocks" size={17} /></span>
    <strong>{activity.name}</strong><span>{i18n.t(`projectAgent.chat.agent.${activity.state}`)}</span>
    <PeerIcon name="chevronRight" size={14} className="bot-agent-open" />
  </button>;
}
