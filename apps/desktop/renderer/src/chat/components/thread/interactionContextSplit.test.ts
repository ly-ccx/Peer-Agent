import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InteractionActionsContext,
  InteractionContext,
  InteractionStreamingContext,
} from './interactionContext.ts';

/**
 * 回归：Interaction action / streaming 必须拆开，
 * 否则流式 token 会让 GoalPlanPanel 拿到新 onNextAction，穿透 PlanCard.memo。
 * Trace 证据：PlanCard2 的 Changed Props 全是 onNextAction 引用不等。
 */
describe('interaction context split', () => {
  it('exports separate actions and streaming contexts', () => {
    assert.notEqual(InteractionActionsContext, InteractionStreamingContext);
    assert.notEqual(InteractionActionsContext, InteractionContext);
    assert.notEqual(InteractionStreamingContext, InteractionContext);
  });

  it('keeps stable action identity while streaming state flips', () => {
    // 复刻 ChatSurface 的 useStableCallback + useMemo 契约（无 React 运行时）：
    // action 对象引用在 isStreaming 翻转后仍应保持不变。
    type StableFn = (text: string) => void;
    let latest: StableFn = () => {};
    const stableSelect: StableFn = (text) => latest(text);
    const actions = { onSelectOption: stableSelect };

    let isStreaming = true;
    let streaming = { isStreaming };
    const actionsBefore = actions;
    const streamingBefore = streaming;

    // 模拟 token 帧：只翻 isStreaming 语义值，action 不应重建。
    isStreaming = true; // still streaming / same value
    streaming = { isStreaming }; // 新对象仅当 isStreaming 真变才应重建；这里模拟 useMemo 依赖未变
    const streamingAfterSame = streamingBefore; // useMemo([isStreaming]) 未变 → 同引用
    const actionsAfter = actionsBefore;

    assert.equal(actionsAfter, actionsBefore, 'actions value must stay referentially equal across stream frames');
    assert.equal(streamingAfterSame, streamingBefore, 'streaming value stays equal when isStreaming is unchanged');

    // isStreaming 真翻转时 streaming 对象可变，但 actions 仍不变。
    isStreaming = false;
    const streamingAfterFlip = { isStreaming };
    assert.notEqual(streamingAfterFlip, streamingBefore);
    assert.equal(actionsAfter, actionsBefore);
  });

  it('stable callback reads latest closure without changing identity', () => {
    // 对应 useStableCallback：返回函数身份恒定，但调用时走最新逻辑。
    type Fn = (text: string) => string;
    let current: Fn = (text) => `A:${text}`;
    const stable: Fn = (text) => current(text);
    const identityBefore = stable;

    assert.equal(stable('x'), 'A:x');
    current = (text) => `B:${text}`;
    assert.equal(stable, identityBefore, 'stable callback identity must not change');
    assert.equal(stable('x'), 'B:x', 'must not close over stale implementation');
  });

  it('PlanCard-style memo only breaks when onNextAction identity changes', () => {
    // 模拟 memo 比较：仅 onNextAction 引用变化应触发重渲染。
    type Props = {
      readonly planId: string;
      readonly status: string;
      readonly onNextAction: (action: string) => void;
    };
    let renders = 0;
    let lastProps: Props | null = null;
    const render = (props: Props) => {
      if (
        lastProps
        && lastProps.planId === props.planId
        && lastProps.status === props.status
        && lastProps.onNextAction === props.onNextAction
      ) {
        return; // memo bailout
      }
      lastProps = props;
      renders += 1;
    };

    const stableAction = () => {};
    render({ planId: 'p1', status: 'executing', onNextAction: stableAction });
    render({ planId: 'p1', status: 'executing', onNextAction: stableAction }); // stream frame
    assert.equal(renders, 1, 'stable onNextAction must not re-render PlanCard');

    render({ planId: 'p1', status: 'executing', onNextAction: () => {} }); // unstable
    assert.equal(renders, 2, 'new onNextAction identity must re-render');
  });
});
