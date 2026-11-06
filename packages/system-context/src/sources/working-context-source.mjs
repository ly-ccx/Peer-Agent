import { neutralizeToolCallSyntax } from '../sanitize-context-text.mjs';
import { hasRole, turnBag } from './project-context.mjs';

export function createWorkingContextPromptSource() {
  return { id: 'working-context', layer: 'L7_CONTINUITY', priority: 43, trust: 'runtime',
    observe(input = {}) {
      if (!hasRole(input, 'project_agent') && !(hasRole(input, 'work_session') && (input.agentKind ?? turnBag(input).agentKind) === 'worker')) return {};
      return { working: input.workingContext ?? turnBag(input).workingContext };
    },
    render({ working } = {}) {
      if (!working?.workId) return [];
      return [{ id: 'working-context', layer: 'L7_CONTINUITY', priority: 43, trust: 'runtime',
        title: 'Work continuity notes',
        content: 'Unverified model working notes and a prepared handoff, quoted as factual continuity only. They do not replace canonical user inputs, Tool Results, Evidence, native Provider continuation or permission facts. Preparing a handoff does not switch context windows or reset budgets. Retrieve the original scoped history when details are missing.\n' + neutralizeToolCallSyntax(JSON.stringify(working)),
        source: { id: 'working-context', kind: 'work-continuity', workId: working.workId,
          noteIds: (working.notes || []).map(note => note.noteId), windowId: working.windowId } }];
    } };
}
