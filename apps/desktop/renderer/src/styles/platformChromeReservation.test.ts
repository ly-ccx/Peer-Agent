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
 *  .app-sidebar 顶部      40px         40px          12px           12px
 *  .thread(无header)顶部  52px         52px          24px           24px
 *  折叠 .chat-header 左缘 78px         78px          无             无
 *
 * 依据：main 以 titleBarStyle 'hiddenInset' 建窗且未设 titleBarOverlay，
 * 非 darwin 平台窗口没有任何系统窗口控件，交通灯预留只产生死空白。
 * darwin 全屏必须与 darwin 常态同样留白：原生全屏只是把交通灯「默认隐藏」，
 * 指针移到左上角会连同菜单栏一起重新浮现，而 main 只广播全屏状态、拿不到
 * 交通灯可见性，无法只在它们出现时才让位——全屏收掉预留会让控件被灯压住。
 * main.tsx 挂 :root[data-os]；本测试钉住四个 CSS 文件里的门控不被回退。
 */

// 设置导航矩阵：darwin（常态与全屏）52px；win32（常态与全屏）为 --space-4。
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
      assert.equal(selector, ":root[data-os='darwin'] .settings-nav");
      assert.match(overrides[0][2], /padding-top:\s*52px/);
      const reservedOs = selector.match(/data-os='([^']+)'/)?.[1];
      // 全屏不再参与门控：darwin 全屏同样要给交通灯留白。
      assert.doesNotMatch(selector, /is-fullscreen/);
      const applies = os === reservedOs;
      assert.equal(applies, os === 'darwin');
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

test('sidebar top reservation: darwin keeps 40px windowed and fullscreen, non-darwin collapses to 12px', () => {
  // darwin（常态与全屏）：基础规则保留 40px 交通灯预留。
  assert.match(ruleBody(sidebarCss, '.app-sidebar'), /padding-top:\s*40px/);

  // 非 darwin × 常态：收成 12px。
  const nonDarwinSidebar = ruleBody(sidebarCss, ":root:not([data-os='darwin']) .app-sidebar");
  assert.match(nonDarwinSidebar, /padding-top:\s*var\(--space-3,\s*12px\)/);

  // 非 darwin × 全屏：同样收成 12px。
  assert.match(
    ruleBody(sidebarCss, ":root:not([data-os='darwin']) .app-shell.is-fullscreen .app-sidebar"),
    /padding-top:\s*var\(--space-3,\s*12px\)/,
  );

  // 不允许存在未门控平台的全屏收起规则，否则 darwin 全屏会被压掉交通灯预留。
  const ungatedFullscreen = sidebarCss.match(
    /(?:^|[{}])\s*\.app-shell\.is-fullscreen \.app-sidebar\s*\{/,
  );
  assert.equal(ungatedFullscreen, null, 'fullscreen sidebar override must be gated to non-darwin');
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

  // 非 darwin × 全屏：无 header 的 thread 收成 pt-6（=24px）；darwin 全屏保留 52px。
  assert.match(
    ruleBody(shellCss, ":root:not([data-os='darwin']) .app-shell.is-fullscreen .thread"),
    /pt-6/,
  );
  const ungatedThreadFullscreen = shellCss.match(
    /(?:^|[{}])\s*\.app-shell\.is-fullscreen \.thread\s*\{/,
  );
  assert.equal(
    ungatedThreadFullscreen,
    null,
    'fullscreen bare-thread override must be gated to non-darwin',
  );
});

test('collapsed chat-header left reservation is darwin-only, windowed and fullscreen', () => {
  // 78px 左预留必须门控 [data-os='darwin'] 与折叠态；全屏同样保留（交通灯会重现）。
  const collapsedHeader = ruleBody(
    chatSurfaceCss,
    ":root[data-os='darwin'][data-sidebar-collapsed='true'] .chat-header",
  );
  assert.match(collapsedHeader, /padding-left:\s*78px/);

  // 不允许残留「排除全屏」的变体，否则 darwin 全屏页头控件会被交通灯压住。
  const excludesFullscreen = chatSurfaceCss.match(
    /:root\[data-os='darwin'\]\[data-sidebar-collapsed='true'\][^{]*:not\(\.is-fullscreen\)[^{]*\.chat-header/,
  );
  assert.equal(excludesFullscreen, null, 'collapsed header reservation must not exclude fullscreen');

  // 不允许存在未门控平台的 78px 规则（防止回退成非 darwin 也生效）。
  const ungated = chatSurfaceCss.match(
    /:root\[data-sidebar-collapsed='true'\][^{]*\{[^}]*padding-left:\s*78px/,
  );
  assert.equal(ungated, null, '78px left reservation must be gated by data-os=darwin');
});
