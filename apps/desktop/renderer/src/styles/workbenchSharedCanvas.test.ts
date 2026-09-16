import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const workbenchCss = readFileSync(join(stylesDir, 'workbench.css'), 'utf8');
const shellCss = readFileSync(join(stylesDir, 'shell.css'), 'utf8');
const tokensCss = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');

// 只认「独立成条」的规则（选择器整体出现在行首或逗号后），避免匹配到
// `:root[data-workbench-resizing='true'] .workbench-panel` 这类带前缀的规则体。
function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('(?:^|[\\n,])\\s*' + escaped + '\\s*\\{([^}]*)\\}');
  const match = css.match(pattern);
  assert.ok(match, 'Expected CSS rule for ' + selector);
  return match[1];
}

test('workbench and chat columns paint the same opaque canvas token', () => {
  const panel = ruleBody(workbenchCss, '.workbench-panel');
  const thread = ruleBody(shellCss, '.thread');

  // 真源：两列都用 --chrome-canvas，右列不再让 .app-layout 的玻璃底透出。
  const sharedSurface = /background:\s*var\(--chrome-canvas,\s*var\(--za-app-bg\)\);/;
  assert.match(panel, sharedSurface);
  assert.match(thread, sharedSurface);
  assert.doesNotMatch(panel, /background:\s*transparent;/);
});

test('opening the workbench squares off only the chat column right corners', () => {
  const seam = ruleBody(workbenchCss, ":root[data-workbench-open='true'] .thread");

  assert.match(seam, /border-top-right-radius:\s*0;/);
  assert.match(seam, /border-bottom-right-radius:\s*0;/);
  // 左侧仍保留悬浮纸面圆角：只收右侧两个角。
  assert.doesNotMatch(seam, /border-top-left-radius/);
  assert.doesNotMatch(seam, /border-bottom-left-radius/);
  assert.doesNotMatch(seam, /border-radius:\s*0;/);
});

test('the seam rule only fires for the root layout, not inside drawers', () => {
  // 抽屉内 Workbench 用 layoutHost='local'，根节点不会写 data-workbench-open，
  // 因此这条规则只作用于根三栏布局。
  const scoped = workbenchCss.match(/:root\[data-workbench-open='true'\]\s+\.thread/g) ?? [];
  assert.equal(scoped.length, 1, 'expected exactly one root-scoped seam rule');
});

test('every palette defines the shared canvas token so both columns stay matched', () => {
  // 浅色 / 深色 / catppuccin 浅色深色各一处；自定义主题经 --za-app-bg 回落。
  const definitions = tokensCss.match(/--chrome-canvas:\s*[^;]+;/g) ?? [];
  assert.ok(definitions.length >= 4, 'expected >=4 --chrome-canvas definitions, got ' + definitions.length);
  assert.match(tokensCss, /--za-app-bg:\s*var\(--za-custom-bg/);
});
