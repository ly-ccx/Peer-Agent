import { createRoot } from 'react-dom/client';
import { createI18n } from '@peer-agent/i18n';
import { BotWorkPanel } from '../renderer/src/project-agent/conversation/BotWorkPanel';
import { ObligationGrantList } from '../renderer/src/project-agent/conversation/ObligationGrantCard';
import { useObligationGrants } from '../renderer/src/project-agent/state/useObligationGrants';
import { indexBotWork } from '../renderer/src/project-agent/state/botWorkState';

function Fixture() {
  const i18n = createI18n('zh-CN');
  const obligations = useObligationGrants('workspace', 'parent', async () => {});
  return <BotWorkPanel workspaceId="workspace" workIndex={indexBotWork([], true)} rows={[]} messages={[]}
    recovering={false} headerTarget={null} i18n={i18n} onOpenTask={() => {}} onRefreshWork={async () => {}}
    obligationGrants={obligations.grants} obligationError={obligations.error} obligationSubmittingId={obligations.submittingId}
    onObligationConfirm={obligations.confirm} onObligationReject={obligations.reject} onObligationRetry={obligations.retry}>
    <div className="bot-convo">
      <ObligationGrantList grants={obligations.grants} error={obligations.error} submittingId={obligations.submittingId}
        i18n={i18n} onConfirm={obligations.confirm} onReject={obligations.reject} onRetry={obligations.retry} />
    </div>
  </BotWorkPanel>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
