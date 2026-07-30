import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const appTsx = join(here, '../../App.tsx');
const gateTsx = join(here, 'FullDiskAccessStartupGate.tsx');

test('startup shell mounts FullDiskAccessStartupGate after main shell is ready', () => {
  const src = readFileSync(appTsx, 'utf8');
  assert.match(src, /import \{ FullDiskAccessStartupGate \}/);
  assert.match(src, /<FullDiskAccessStartupGate enabled=\{showMainShell\} isZh=\{isZh\} \/>/);
  // 不应绑到不存在的 ready 变量。
  assert.doesNotMatch(src, /enabled=\{ready\}/);
});

test('startup gate uses session-import preflight + app drag APIs', () => {
  const src = readFileSync(gateTsx, 'utf8');
  assert.match(src, /getBrowserSessionImportPreflight/);
  assert.match(src, /openFullDiskAccessSettings/);
  assert.match(src, /startAppDrag/);
  // 启动门文案应强调“打开时检测”，不是 Browser 导入向导专属。
  assert.match(src, /需要完全磁盘访问权限|Full Disk Access required/);
  // 固定使用品牌 LOGO，而不是蓝色 App 占位。
  assert.match(src, /BRAND_LOGO_SRC = '\.\/logo\.png'/);
  assert.match(src, /fda-permission-logo/);
  assert.match(src, /fda-permission-card/);
  assert.match(src, /在 Finder 中显示 App|Reveal app in Finder/);
  // 不依赖 Overlay render props，降低 hooks 复杂度。
  assert.doesNotMatch(src, /from '\.\/Overlay'/);
  assert.match(src, /createPortal/);
});


test('root renderer wraps App with AppErrorBoundary', () => {
  const mainTsx = readFileSync(join(here, '../../main.tsx'), 'utf8');
  assert.match(mainTsx, /AppErrorBoundary/);
  assert.match(mainTsx, /<AppErrorBoundary>/);
});
