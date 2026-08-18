import { joinPromptSections } from '../rendering.mjs';
import { isSelfDrivenMode } from '../mode-utils.mjs';

// 建设型交叉证伪（Construction falsification）。
// 与 diagnosis-gate（症状先根因）并列，不把诊断门兼管建设型矩阵。
// 设计：peer-knowledge/design/product/agent-mode-default-and-adaptive-planning.md

export function renderConstructionFalsificationPrompt() {
  return joinPromptSections([
    'Construction falsification for building / contract / codegen work.',
    'Diagnosis gate covers symptom-style root cause. This source covers construction: new behavior, library contracts, serializers, flags, generated code, and orthogonal config axes.',
    'Before declaring done:',
    '1. List the independent behavior axes named by the original task or contract (examples: flatten vs nested; rename map vs field name; parent vs child serialize_by_alias; encode vs decode; optional vs required).',
    '2. If there are two or more axes, write the cross-product matrix. Each cell is a named test (or an explicit out-of-scope reason with a contract citation).',
    '3. A green single-axis suite is not completion. Tests that only cover the axis you implemented do not close orthogonal pins from the original task.',
    '4. Stop only when each required cell has Evidence from an actual tool result, or a written skip.',
    'Unattended hosts (eval / exec / no interactive user): do not wait for design approval or extra user questions. Convert the pinned task into the matrix and keep working.',
    'Do not pad the suite with generic coverage. Only test axes the task or contract actually named.',
  ]);
}

export function createConstructionFalsificationPromptSource() {
  return {
    id: 'agent.construction-falsification',
    layer: 'L1_AGENT',
    // priority 与 adaptive / diagnosis 同为 1：同层按 id 字典序 →
    // adaptive-planning → construction-falsification → diagnosis-gate → mcp-host
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = typeof input.mode === 'string' ? input.mode.trim() : 'chat';
      return {
        available: isSelfDrivenMode(mode),
        mode,
      };
    },
    render(observation) {
      if (!observation?.available) return [];
      return [{
        id: 'agent.construction-falsification',
        layer: 'L1_AGENT',
        priority: 1,
        title: 'Construction falsification',
        content: renderConstructionFalsificationPrompt(),
        source: { id: 'agent.construction-falsification', kind: 'agent-policy', mode: observation.mode },
        trust: 'runtime',
      }];
    },
  };
}
