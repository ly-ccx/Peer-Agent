/** Match the current nonmodal resource host and the retained classic drawer fallback. */
export const BOT_DETAIL_SURFACE = '.resource-workspace.workbench-panel--open:has(.resource-details-slot[data-active="true"]):not([inert]), .bot-drawer-dock:not([inert]), .pa-overlay-panel.bot-drawer-panel';
export const BOT_DETAIL_CLOSE = '.resource-workspace:has(.resource-details-slot[data-active="true"]):not([inert]) > .resource-workspace-header button:is([aria-label="收起工作区"], [aria-label="Collapse workspace"]), .bot-drawer-dock:not([inert]) .bot-drawer-head button, .pa-overlay-panel.bot-drawer-panel .bot-drawer-head button';
export const BOT_DETAIL_TITLE = '.resource-workspace:has(.resource-details-slot[data-active="true"]):not([inert]) .resource-detail-heading > span, .bot-drawer-dock:not([inert]) .bot-drawer-head > p, .pa-overlay-panel.bot-drawer-panel .bot-drawer-head > p';

/** Expand production task details before interacting with secondary controls. */
export async function openFullTask(page) {
  const detail = page.locator(BOT_DETAIL_SURFACE).locator('.bot-task-detail');
  const full = detail.locator('.bot-task-full');
  const toggle = detail.locator('.bot-task-full-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await full.locator('.bot-task-full-content').waitFor({ state: 'visible' });
  await full.evaluate(async node => {
    await Promise.all(node.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
