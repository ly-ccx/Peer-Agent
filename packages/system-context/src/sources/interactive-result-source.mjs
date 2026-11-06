import { INTERACTIVE_CONTEXT } from '@peer-agent/interactive-content/context';
import { estimateContextTextTokens } from '@peer-agent/runtime-core';
import { turnBag } from './project-context.mjs';

const PUBLISH = 'local.interactive.publish', INSPECT = 'local.interactive.inspect';
const READ_RULES = 'Peer interactive result inspection. Use only projected inspect_interactive_result and an admitted fixed result/publication reference. Main Bot reads metadata/text only; worker/Verifier may read fixed program/data and bounded pure evaluation. User conditions must be explicitly admitted frozen followups, never latest UI state. Keep source classification, version, redaction and truncation. Pending/unknown publication requires original-call reconciliation, never reexecution or new publication. Read/compute Evidence is not source business truth, task verification or acceptance. Interactive controls do not grant execution, permission or canonical user input. Existing report, verification and post_reply paths retain authority.';

export function createInteractiveResultPromptSource() {
  return { id: 'interactive-results', layer: 'L5_TOOL_RULES', priority: 38, trust: 'builtin',
    observe(input = {}) {
      const capabilities = Array.isArray(input.interactiveResultCapabilities) ? input.interactiveResultCapabilities : [];
      const role = input.role, kind = input.agentKind ?? turnBag(input).agentKind;
      const worker = role === 'work_session' && kind === 'worker';
      const reader = role === 'project_agent' || worker || role === 'work_session' && ['verifier', 'visual_verifier'].includes(kind);
      if (!reader || !capabilities.includes(INSPECT)) return null;
      const publishing = worker && capabilities.includes(PUBLISH);
      const content = publishing ? INTERACTIVE_CONTEXT.content : READ_RULES;
      const estimatedTokens = estimateContextTextTokens(content);
      if (estimatedTokens > 4096 || Buffer.byteLength(content, 'utf8') > 16 * 1024) throw Error('interactive_context_budget');
      return { content, publishing, estimatedTokens };
    },
    render(observation) {
      if (!observation) return [];
      return [{ id: 'interactive-results', content: observation.content,
        source: { id: 'interactive-results', kind: 'registered-catalog', libraryVersion: INTERACTIVE_CONTEXT.libraryVersion,
          specHash: INTERACTIVE_CONTEXT.specHash, components: observation.publishing ? INTERACTIVE_CONTEXT.componentNames : [],
          functions: observation.publishing ? INTERACTIVE_CONTEXT.functionNames : [],
          capabilities: observation.publishing ? [PUBLISH, INSPECT] : [INSPECT], tokenSource: 'host_conservative_estimate', estimatedTokens: observation.estimatedTokens } }];
    },
  };
}
