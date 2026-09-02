import { joinPromptSections } from '../rendering.mjs';

// ADR 72：网页任务默认入口是 L1 browser_*，不是 L2 Playwright。
// 本 Source 只写选择规则，不删除 browser_external_* 投影。

export function renderWebEntryPrompt() {
  return joinPromptSections([
    'Web task default entry (ADR 72).',
    'For ordinary webpage work, use the in-app `browser_*` tools (`browser_open_panel`, `browser_navigate`, `browser_click`, `browser_type`, `browser_hover`, `browser_scroll`, `browser_key`, `browser_drag`, `browser_screenshot`, `browser_read_dom`).',
    'The user should see the same Workbench page you operate. Do not open Playwright / `browser_external_*` as the default path because L1 click is weak, a locator is missing, or the page looks hard.',
    '`browser_external_*` is an explicit isolated Chromium session, not the visible in-app browser and not the user daily Chrome profile. Use it only when the task needs a separate profile, multiple pages/contexts, or an environment L1 cannot host.',
    'Never attach the in-app webview as a Playwright page, and never expose raw Playwright/CDP.',
  ]);
}

export function createWebEntryPromptSource() {
  return {
    id: 'runtime.web-entry',
    layer: 'L5_TOOL_RULES',
    priority: 4,
    trust: 'runtime',
    observe() {
      return { available: true };
    },
    render(observation) {
      if (!observation?.available) return [];
      return [{
        id: 'runtime.web-entry',
        layer: 'L5_TOOL_RULES',
        priority: 4,
        title: 'Web task default entry',
        content: renderWebEntryPrompt(),
        source: { id: 'runtime.web-entry', kind: 'runtime' },
        trust: 'runtime',
      }];
    },
  };
}
