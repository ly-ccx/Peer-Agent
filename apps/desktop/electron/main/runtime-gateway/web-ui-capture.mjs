import { createHash } from 'node:crypto';

/**
 * 网页侧的受治理 UI 产物（知识第 33 节）。
 *
 * 与桌面预览的差别是刻意的：
 * - 只有显式声明 `planId` 的截图才进入治理；普通浏览截图行为不变。
 * - 没有「关闭」义务，改用「捕获后改动即失效」。
 * - 身份三字段来自网页本身：会话实例、最终 URL、捕获时渲染文本。
 *
 * 产物写入的是同一套受治理产物仓（host='web' 走 local-web-ui-artifact:// 前缀），
 * 因此判定绑定、准入、证据索引等第 27–31 节规则原样复用，不需要第二条链。
 */
export function createWebUiCapture({ goalPlanStore, authority, artifacts, hostVisualReview, workspaceRoot } = {}) {
  if (!goalPlanStore || !authority?.requirePreview || !artifacts?.write) return null;
  const hash = value => createHash('sha256').update(String(value ?? '')).digest('hex');
  // 会改动页面、从而让先前截图不再代表当前交付物的动作。
  const PAGE_CHANGING = new Set(['navigate', 'click', 'type', 'key', 'drag']);

  function capture({ planId, conversationId, toolCallId, png, width, height, finalUrl, renderedText, instanceId, scene = 'application' }) {
    const plan = planId ? goalPlanStore.getPlan(planId) : null;
    if (!plan) throw new Error('web-plan-missing');
    if (!conversationId || plan.conversationId !== conversationId) throw new Error('web-plan-conversation-mismatch');
    if (!instanceId) throw new Error('web-instance-missing');
    const identity = { instanceId, sourceFingerprint: hash(finalUrl), buildFingerprint: hash(renderedText) };
    authority.requirePreview(plan, identity, 'web');
    authority.beginObservation(plan, scene);
    const stored = artifacts.write({ plan, observation: { ...identity, host: 'web', scene }, toolCallId, png, width, height });
    authority.recordObservation(plan, stored);
    // 观察登记后由宿主调度同一条独立复核；失败必须落成可诊断判定（第 30.2 节）。
    hostVisualReview?.schedule?.(plan, stored, {
      goalPlanStore,
      workspacePath: workspaceRoot,
      onFailure: (failedPlanId, reason) => {
        try { authority.recordReviewFailure(failedPlanId, null, reason); } catch { /* best-effort */ }
      },
    });
    return stored;
  }

  function invalidateAfterAction({ conversationId, action }) {
    if (!conversationId || !PAGE_CHANGING.has(action)) return { invalidated: [] };
    return authority.invalidateWebRequirements(conversationId, `web-page-changed:${action}`);
  }

  return { capture, invalidateAfterAction, isPageChanging: action => PAGE_CHANGING.has(action) };
}
