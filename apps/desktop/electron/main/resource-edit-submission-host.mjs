import { createResourceEditExecutionJournal } from './resource-edit-execution-journal.mjs';
import { createResourceEditPermissionBridge } from './resource-edit-permission-bridge.mjs';
import { createResourceEditSubmissionService } from './resource-edit-submission-service.mjs';
import { createResourceEditRuntime } from './resource-edit-runtime.mjs';
import { createConfiguredHookRunner } from './runtime-gateway/hook-config.mjs';
/** Main-process composition only. No task/model execution or alternate file writer is introduced. */
export function createResourceEditSubmissionHost({ edits, storage, sources, authority, approvalStore, sessionStore, userDataPath,
  createHooks = createConfiguredHookRunner } = {}) {
  const current = (binding, operation) => edits.isSubmissionCurrent(binding, operation);
  const permissions = createResourceEditPermissionBridge({ authority, approvalStore, isCurrent: current, notify: edits.notifyOperation });
  const journal = createResourceEditExecutionJournal({ storage, authorizeStart: current, isScopeCurrent: current,
    readCurrent: (operation, binding) => sources.readSubmissionCurrent(binding.sender, binding.source, operation.target), notify: edits.notifyOperation,
    createRuntime: (operation, binding, ports) => ({ async execute(dispatch, options) {
      permissions.begin(operation, binding);
      try {
        const source = await sources.resolveSubmissionTarget(binding.sender, binding.source, operation.target);
        const runtime = createResourceEditRuntime({ sessionStore, workspaceRoot: source?.ok ? source.root : undefined,
          hookRunner: createHooks({ userDataPath, workspaceRoot: source?.ok ? source.root : undefined }),
          isIntentCurrent: ports.isIntentCurrent, resolveTarget: async (_op, target) => {
            // A failed initial source proof cannot recover mid-call while silently skipping its project Hook configuration.
            if (!source?.ok) return source ?? { ok: false, code: 'RESOURCE_EDIT_SOURCE_UNAVAILABLE' };
            const next = await sources.resolveSubmissionTarget(binding.sender, binding.source, target);
            return next?.ok && next.root !== source.root ? { ok: false, code: 'RESOURCE_EDIT_SOURCE_CHANGED' } : next;
          },
          requestPermission: (op, request, context) => permissions.request(op, binding, request, context),
          recordExecution: ports.recordExecution, recordPostlude: ports.recordPostlude });
        return await runtime.execute(dispatch, options);
      } finally { permissions.finish(operation); }
    } }),
  });
  const submissions = createResourceEditSubmissionService({ edits, storage, journal, permissions, sources });
  return { submissions, async dispose() { journal.dispose(); permissions.dispose(); await journal.drain(); } };
}
