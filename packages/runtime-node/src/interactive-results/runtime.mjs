import { createInteractiveAuthority } from './authority.mjs';
import { createInteractiveCapture } from './capture.mjs';
import { createInteractiveMaterialSource } from './material-source.mjs';
import { createInteractiveResultProvider } from './provider.mjs';
import { createInteractiveStateStore } from './state-store.mjs';
import { createInteractiveResultStore } from './store.mjs';

/** One shared domain instance per host. Composition roots supply real local facts. */
export function createInteractiveRuntime({ rootDir, goalPlanStore, conversationStore, getBotConversationId,
  holdsLease, enabled, classifyContext, readUserMaterial, now, validate } = {}) {
  const resultStore = createInteractiveResultStore({ ...(rootDir ? { rootDir } : {}), ...(now ? { now } : {}),
    assertCompatibility: () => goalPlanStore?.assertInteractiveEvidenceCompatible?.() === true });
  const stateStore = createInteractiveStateStore({ resultStore, ...(now ? { now } : {}) });
  const authority = createInteractiveAuthority({ goalPlanStore, conversationStore, resultStore, getBotConversationId, holdsLease, enabled, classifyContext });
  const materialSource = createInteractiveMaterialSource({
    readToolResult: (source, execution) => resultStore.readMaterial(execution.owner, source), readUserMaterial,
    admitSource: (source, execution) => execution.assertCurrent() === true && execution.admitMaterial(source) === true,
    ...(now ? { now } : {}),
  });
  const provider = createInteractiveResultProvider({ store: resultStore, stateStore, materialSource, resolveAuthority: authority.resolve,
    index: goalPlanStore, ...(now ? { now } : {}), ...(validate ? { validate } : {}) });
  return { resultStore, stateStore, provider, authority, captureExecution: createInteractiveCapture({ resultStore, resolveAuthority: authority.resolve, ...(now ? { now } : {}) }),
    recoverOwner(owner) { return provider.recoverOwner(owner, candidate => holdsLease?.(candidate.workspaceId) === true
      && getBotConversationId?.(candidate.workspaceId) === candidate.conversationId); },
    close() { stateStore.close(); resultStore.close(); } };
}
