import { useEffect } from 'react';
import { clientApi } from '../clientApi';
import { useResourceActions, useResourceRead } from '../ui/resources/useResourceState';

/** Definition, run-list and receipt reads have independent identities and failure states. */
export function useAutomationResources(automationId: string | null, runId: string | null) {
  const bootstrap = useResourceRead('automations', () => clientApi.automationsBootstrap());
  const runs = useResourceRead(`automation-runs:${automationId}`, () => automationId
    ? clientApi.automationRunsList({ automationId, limit: 100 }) : Promise.resolve([]), Boolean(automationId));
  const run = useResourceRead(`automation-run:${runId}`, async () => {
    const result = runId ? await clientApi.automationRunsGet({ runId }) : null;
    if (!result) throw Error('RUN_NOT_FOUND');
    return result;
  }, Boolean(runId));
  const actions = useResourceActions('automations');
  useEffect(() => clientApi.onAutomationsChanged(() => {
    void bootstrap.reload();
    if (automationId) void runs.reload();
    if (runId) void run.reload();
  }), [automationId, runId, bootstrap.reload, runs.reload, run.reload]);
  return { bootstrap, runs, run, actions };
}
