import { bulletList, joinPromptSections } from '../rendering.mjs';
import { resolveGoalPlanGate } from '../../chat-runtime/goal-mode-gate.mjs';

// Brainstorming-before-implementation behavior, adapted from the "superpowers"
// brainstorming skill into a resident Peer Agent behavior norm (L1_AGENT layer).
// Localization notes vs the upstream skill:
// - Removed the Visual Companion / browser-window pairing flow.
// - Rewrote the terminal "invoke writing-plans skill" handoff into Peer Agent's
//   own goal-mode planning transition.
// - Kept the design-before-code gate, one-question-at-a-time discipline,
//   2-3 alternatives rule, YAGNI, incremental approval, and red flags.

export function renderBrainstormingPrompt() {
  return joinPromptSections([
    [
      'Design-before-implementation:',
      'Before any creative or building work — adding a feature, creating a component, adding functionality, or changing existing behavior — first turn the idea into an agreed design through collaborative dialogue. Do not jump straight to writing code or files for non-trivial work.',
    ].join('\n'),
    [
      'Brainstorming flow:',
      bulletList([
        'Explore the current project context first (read the relevant code, docs, and contracts) before proposing anything.',
        'Ask clarifying questions to uncover the real intent, requirements, and constraints.',
        'Propose 2-3 distinct approaches with trade-offs before settling on one.',
        'Present the design in small sections and get approval on each before moving on.',
        'Apply YAGNI ruthlessly — remove unnecessary features and scope from every design.',
        'Stay flexible — go back and re-clarify when something does not make sense.',
      ]),
    ].join('\n'),
    [
      'Question discipline:',
      bulletList([
        'Ask one question at a time; do not overwhelm with multiple questions at once.',
        'Prefer multiple-choice questions over open-ended ones when possible, since they are easier to answer.',
        'When a decision, approval, or choice is needed, ask the user instead of deciding on their behalf.',
      ]),
    ].join('\n'),
    [
      'Design approval gate:',
      bulletList([
        'Do not start implementation until the user has reviewed and approved the design.',
        'After approval, transition into planning (goal mode) to produce a detailed, verifiable implementation plan; do not silently skip the planning step.',
        'Only improve adjacent code that the design legitimately touches; do not propose unrelated refactoring.',
      ]),
    ].join('\n'),
    [
      'Red flags (stop and correct):',
      bulletList([
        'Jumping to implementation before the design is agreed.',
        'Asking several questions in one turn instead of one focused question.',
        'Presenting a single approach as the only option without alternatives.',
        'Expanding scope beyond what the user asked for.',
      ]),
    ].join('\n'),
  ]);
}

export function createBrainstormingPromptSource() {
  return {
    id: 'agent.brainstorming',
    layer: 'L1_AGENT',
    priority: 0,
    trust: 'builtin',
    observe(input = {}) {
      // 阶段感知：goal 模式一旦有「已就绪（获批/执行中/已完成）」的计划，
      // 即进入连续执行阶段，撤掉设计协作规范，避免与「一口气执行完成」冲突。
      // 草拟阶段（计划尚未获批）与非 goal 模式仍保留 brainstorming。
      if (input.mode === 'goal') {
        const planGate = resolveGoalPlanGate(input.conversationId, input.goalPlanStore);
        if (planGate.hasApprovedPlan) {
          return { available: false };
        }
      }
      return { available: true };
    },
    render(observation = {}) {
      // 装配器不读取 observation.available，源必须在 render 内自行短路。
      if (observation.available === false) return [];
      return [{
        id: 'agent.brainstorming',
        layer: 'L1_AGENT',
        priority: 0,
        title: 'Brainstorming before implementation',
        content: renderBrainstormingPrompt(),
        source: { id: 'agent.brainstorming', kind: 'builtin' },
        trust: 'builtin',
      }];
    },
  };
}
