import { joinPromptSections } from '../rendering.mjs';

// Agent 默认模式下的自适应规划深度规则（L0–L3）。
// 设计：peer-knowledge/design/product/agent-mode-default-and-adaptive-planning.md
// 仅在 chat（Agent）与 legacy goal 自驱模式下注入，避免污染 Plan 审批文案。

function isSelfDrivenMode(mode) {
  return mode === 'chat' || mode === 'goal';
}

export function renderAdaptivePlanningPrompt() {
  return joinPromptSections([
    'Adaptive planning depth (Agent / self-driven modes only).',
    'Before the first side-effecting action, pick one depth and state it briefly when useful:',
    '- L0 Direct: pure Q&A / explanation / single fact lookup — no formal GoalPlan.',
    '- L1 Micro-plan: small low-risk change (≈1–2 files, clear scope) — short 3–6 step plan in the turn; formal GoalPlan optional.',
    '- L2 Auto Goal: multi-step feature, fix, or cross-file work needing verify loop — create formal GoalPlan via goal_create_plan and self-drive without waiting for plan approval.',
    '- L3 Gated Plan: high-risk / irreversible / large cross-module / missing critical decision — use Plan discipline (approval) or request_user_input; do not silent-execute.',
    'Upgrade when impact grows, verify/adjust needs many turns, or the same symptom returns after a failed cosmetic fix.',
    'Downgrade when the task collapses to pure Q&A or a single confirmation.',
    'Do not create formal GoalPlans for L0 "to look professional". Do not skip successCriteria on L2/L3.',
    'When an active plan already exists, continue it (goal_get_plan) instead of spawning zombies.',
  ]);
}

export function createAdaptivePlanningPromptSource() {
  return {
    id: 'agent.adaptive-planning',
    layer: 'L1_AGENT',
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
        id: 'agent.adaptive-planning',
        layer: 'L1_AGENT',
        priority: 1,
        title: 'Adaptive planning depth (L0–L3)',
        content: renderAdaptivePlanningPrompt(),
        source: { id: 'agent.adaptive-planning', kind: 'agent-policy', mode: observation.mode },
        trust: 'runtime',
      }];
    },
  };
}
