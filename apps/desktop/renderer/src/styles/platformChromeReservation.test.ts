import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 窗口 chrome 预留的平台 × 全屏契约。
 *
 * 矩阵（顶部留白均源于 macOS 交通灯预留）：
 *                        darwin常态   darwin全屏   非darwin常态   非darwin全屏
 *  .app-sidebar 顶部      40px         12px          12px           12px
 *  .thread(无header)顶部  52px         24px          24px           24px
 *  折叠 .chat-header 左缘 78px         无            无             无
 *
 * 依据：main 以 titleBarStyle 'hiddenInset' 建窗且未设 titleBarOverlay，
 * 非 darwin 平台窗口没有任何系统窗口控件，交通灯预留只产生死空白。
 * main.tsx 挂 :root[data-os]；本测试钉住三个 CSS 文件里的门控不被回退。
 */

// 设置导航矩阵：darwin 常态 52px；darwin 全屏 / win32 常态 / win32 全屏均为 --space-4。
const stylesDir = dirname(fileURLToPath(import.meta.url));
const settingsCss = readFileSync(join(stylesDir, './settings-page.css'), 'utf8');

for (const os of ['darwin', 'win32']) {
  for (const fullscreen of [false, true]) {
    test(`settings navigation reservation: ${os} × ${fullscreen ? 'fullscreen' : 'windowed'}`, () => {
      const base = ruleBody(settingsCss, '.settings-nav');
      assert.match(base, /padding:\s*var\(--space-4\) var\(--space-3\)/);
      assert.doesNotMatch(base, /padding-top:/, 'base must not reserve traffic-light space');

      // Pin the complete selector, not just the value: both platform and window state
      // must gate the only top-padding override. This is a source-level CSS check.
      const overrides = [...settingsCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, selector, body]) => /\.settings-nav\s*$/.test(selector) && /padding-top:/.test(body));
      assert.equal(overrides.length, 1);
      const selector = overrides[0][1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
      assert.equal(selector, ":root[data-os='darwin'] .app-shell:not(.is-fullscreen) .settings-nav");
      assert.match(overrides[0][2], /padding-top:\s*52px/);
      const reservedOs = selector.match(/data-os='([^']+)'/)?.[1];
      const excludesFullscreen = selector.includes(':not(.is-fullscreen)');
      const applies = os === reservedOs && !(fullscreen && excludesFullscreen);
      assert.equal(applies, os === 'darwin' && !fullscreen);
      assert.match(ruleBody(settingsCss, '.settings-nav-header button'), /-webkit-app-region:\s*no-drag/);
    });
  }
}
const sidebarCss = readFileSync(join(stylesDir, './sidebar.css'), 'utf8');
const shellCss = readFileSync(join(stylesDir, './shell.css'), 'utf8');
const chatSurfaceCss = readFileSync(join(stylesDir, '../chat/styles/chat-surface.css'), 'utf8');

function ruleBody(css: string, selector: string) {
  // 归一化空白：选择器在源文件里可能跨行书写。
  const normalizedCss = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (character) => '\\' + character);
  const match = normalizedCss.match(new RegExp(`(?:^|[{}])\\s*${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('sidebar top reservation: darwin keeps 40px, non-darwin and fullscreen collapse to 12px', () => {
  // darwin × 常态：基础规则保留交通灯预留。
  assert.match(ruleBody(sidebarCss, '.app-sidebar'), /padding-top:\s*40px/);

  // 非 darwin × 常态：收成 12px（与全屏一致）。
  const nonDarwinSidebar = ruleBody(sidebarCss, ":root:not([data-os='darwin']) .app-sidebar");
  assert.match(nonDarwinSidebar, /padding-top:\s*var\(--space-3,\s*12px\)/);

  // darwin × 全屏：既有收起规则保持 12px。
  assert.match(
    ruleBody(sidebarCss, '.app-shell.is-fullscreen .app-sidebar'),
    /padding-top:\s*var\(--space-3,\s*12px\)/,
  );
});

test('bare thread top reservation: darwin keeps 52px, non-darwin collapses to 24px without touching has-header', () => {
  // darwin × 常态：基础规则含 52px 预留（@apply 工具类）。
  assert.match(ruleBody(shellCss, '.thread'), /pt-\[52px\]/);

  // 非 darwin：收成 24px，且必须带 :not(.thread-has-header) 守卫，
  // 否则会以更高特异性覆盖带页头 thread 的 pt-0。
  const nonDarwinThread = ruleBody(
    shellCss,
    ":root:not([data-os='darwin']) .thread:not(.thread-has-header)",
  );
  assert.match(nonDarwinThread, /padding-top:\s*var\(--space-6,\s*24px\)/);

  // 带 header 的 thread 不受平台门控影响（页头是功能内容，非交通灯预留）。
  assert.match(ruleBody(shellCss, '.thread.thread-has-header'), /pt-0/);

  // darwin × 全屏：既有收起规则保持 pt-6（=24px）。
  assert.match(ruleBody(shellCss, '.app-shell.is-fullscreen .thread'), /pt-6/);
});

test('collapsed chat-header left reservation is darwin-only', () => {
  // 78px 左预留必须同时门控 [data-os='darwin'] 与折叠态、排除全屏。
  const collapsedHeader = ruleBody(
    chatSurfaceCss,
    ":root[data-os='darwin'][data-sidebar-collapsed='true'] .app-shell:not(.is-fullscreen) .chat-header",
  );
  assert.match(collapsedHeader, /padding-left:\s*78px/);

  // 不允许存在未门控平台的 78px 规则（防止回退成非 darwin 也生效）。
  const ungated = chatSurfaceCss.match(
    /:root\[data-sidebar-collapsed='true'\][^{]*\{[^}]*padding-left:\s*78px/,
  );
  assert.equal(ungated, null, '78px left reservation must be gated by data-os=darwin');
});
