import type { AgentActivity } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { agentIdentity, agentActivityRunning, currentAgentActivity, agentActivityPresentationId } from '../state/agentActivityState';
import { formatDrawerSessionStatus } from '../state/drawerState';
import type { BotWorkIndex } from '../state/botWorkState';

export function AgentActivityRow({ messageId, activity, workIndex, i18n, onOpen }: {
  readonly messageId: string;
  readonly activity: AgentActivity;
  readonly workIndex: BotWorkIndex;
  readonly i18n: I18nRuntime;
  readonly onOpen: (sessionId: string) => void;
}) {
  const identity = agentIdentity(activity.sessionId);
  const working = agentActivityRunning(activity, workIndex);
  const current = currentAgentActivity(activity,workIndex);
  const session = workIndex.available ? workIndex.byId.get(activity.sessionId) : undefined;
  return <button type="button" id={`bot-msg-${agentActivityPresentationId(activity)}`} data-source-message={messageId} className="bot-agent-activity" data-agent-state={current.state} data-agent-session={activity.sessionId} data-agent-running={working}
    onClick={() => onOpen(activity.sessionId)} title={i18n.t('projectAgent.chat.agent.open')}>
    <span className="bot-agent-marker" data-tone={identity.tone} data-agent-icon={identity.icon}><PeerIcon name={identity.icon} size={18} /></span>
    <strong>{current.name}</strong><span>{current.state === 'verifying' && current.verificationProgress?.observationCount
      ? i18n.t('projectAgent.chat.agent.verificationProgress', { count: current.verificationProgress.observationCount })
      : session ? formatDrawerSessionStatus(session,i18n) : i18n.t(`projectAgent.chat.agent.${current.state}`)}</span>
    <PeerIcon name="chevronRight" size={14} className="bot-agent-open" />
  </button>;
}
