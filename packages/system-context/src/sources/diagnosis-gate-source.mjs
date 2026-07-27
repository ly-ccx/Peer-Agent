import { joinPromptSections } from '../rendering.mjs';

// 症状型任务的诊断门闸（Diagnosis Gate）。
// 设计：peer-knowledge/knowledge/specifications/engineering-rigor-paradigm.md
// 与 brainstorming（建设型设计门）互补：症状先根因，建设先设计。

function isSelfDrivenMode(mode) {
  return mode === 'chat' || mode === 'goal' || mode === 'plan';
}

export function renderDiagnosisGatePrompt() {
  return joinPromptSections([
    'Diagnosis gate for symptom-style work (blurry / slow / wrong / flaky / broken / platform pixels / performance / state sync).',
    'Before the first side-effecting fix, produce a short diagnosis block (in the plan metadata or in your reply):',
    '1. problem_rewrite — real problem in system language (layer + observable symptom).',
    '2. constraints — platform / product / engineering / acceptance constraints; blacklist unfit tools when relevant.',
    '3. root_cause_hypotheses — primary hypothesis + how to falsify it; reject cosmetic-only explanations when a pipeline/contract issue exists.',
    '4. source_of_truth — what becomes the single source of truth after the fix.',
    '5. causal_chain — which chain nodes you will change (resource / loader / state / packaging / tests / …).',
    '6. success_checks — how you will prove the fix (command / preview / log / test); self-check before asking the user to QA.',
    '7. non_goals — symptom therapies you will not do.',
    'Rule: fix pipeline/contract before craft. Prefer one minimal correct chain fix over multi-round user-driven tweaking.',
    'If the user has already rejected the same surface tweak ≥2 times, stop cosmetic iteration, re-diagnose, and upgrade planning depth as needed.',
  ]);
}

export function createDiagnosisGatePromptSource() {
  return {
    id: 'agent.diagnosis-gate',
    layer: 'L1_AGENT',
    // priority 与 adaptive 同为 1：同层按 id 字典序 → adaptive-planning 在 diagnosis-gate 前，
    // 且二者都在 agent.mcp-host（id 更大）之前。
    priority: 1,
    trust: 'runtime',
    observe(input = {}) {
      const mode = typeof input.mode === 'string' ? input.mode.trim() : 'chat';
      return {
        // Plan 也需要诊断纪律；纯 Ask 未来可关闭。当前三模式均注入。
        available: isSelfDrivenMode(mode),
        mode,
      };
    },
    render(observation) {
      if (!observation?.available) return [];
      return [{
        id: 'agent.diagnosis-gate',
        layer: 'L1_AGENT',
        priority: 1,
        title: 'Diagnosis gate',
        content: renderDiagnosisGatePrompt(),
        source: { id: 'agent.diagnosis-gate', kind: 'agent-policy', mode: observation.mode },
        trust: 'runtime',
      }];
    },
  };
}
