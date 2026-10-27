/** Match the current nonmodal resource host and the retained classic drawer fallback. */
export const BOT_DETAIL_SURFACE = '.resource-workspace.workbench-panel--open:has(.resource-details-slot[data-active="true"]):not([inert]), .bot-drawer-dock, .pa-overlay-panel.bot-drawer-panel';
export const BOT_DETAIL_CLOSE = '.resource-workspace:has(.resource-details-slot[data-active="true"]):not([inert]) > .resource-workspace-header button[aria-label="收起工作区"], .bot-drawer-head button';
export const BOT_DETAIL_TITLE = '.resource-workspace:has(.resource-details-slot[data-active="true"]):not([inert]) .resource-detail-heading > span, .bot-drawer-head > p';
