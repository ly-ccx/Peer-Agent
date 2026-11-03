import { parseInteractiveArtifactRef } from '@peer-agent/protocol';
import { createInteractiveTextReader, runInteractiveValidation } from '@peer-agent/runtime-node/interactive-results';

export function taskResultReferences(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  return [...new Set(refs.filter((ref): ref is string => typeof ref === 'string' && !!parseInteractiveArtifactRef(ref)))].slice(0, 20);
}

type ReaderOptions = Parameters<typeof createInteractiveTextReader>[0];
export function createTuiTaskResultReader(options: {
  resultStore: ReaderOptions['resultStore'];
  assertOwner: (owner: { workspaceId: string; conversationId: string }) => boolean;
  readTask: (sessionId: string) => { workspaceId?: string; report?: { evidenceRefs?: readonly string[] } } | null | undefined;
}) {
  const readText = createInteractiveTextReader(options);
  return async function readTaskResult(sessionId: string, ref: string, signal: AbortSignal) {
    const reference = parseInteractiveArtifactRef(ref);
    if (!reference) throw Error('interactive_reference_invalid');
    const current = () => {
      const task = options.readTask(sessionId);
      if (signal.aborted || !options.assertOwner(reference.owner) || task?.workspaceId !== reference.owner.workspaceId
        || !taskResultReferences(task.report?.evidenceRefs).includes(ref)) throw Error('interactive_scope_denied');
    };
    current();
    const summary = readText(reference);
    if (summary.availability !== 'available') return { summary, computation: null, computationUnavailable: false };
    let computation: { text: string; truncated: boolean } | null = null;
    try {
      const fixed = options.resultStore.getVersion(reference);
      const result = await runInteractiveValidation({ operation: 'evaluate', content: fixed.content, values: fixed.content.initialValues }, { signal });
      computation = result.projection;
    } catch { current(); }
    current();
    const latest = readText(reference);
    if (latest.availability !== 'available') return { summary: latest, computation: null, computationUnavailable: false };
    return { summary: latest, computation, computationUnavailable: computation === null };
  };
}
