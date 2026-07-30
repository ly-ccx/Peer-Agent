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
  assert.match(src, /FullDiskAccessStartupGate/);
  assert.match(src, /enabled=\{showMainShell\}/);
});

test('startup gate checks Agent-required OS permissions, not Chrome import', () => {
  const src = readFileSync(gateTsx, 'utf8');
  assert.match(src, /getStartupOsPermissions/);
  assert.match(src, /openFullDiskAccessSettings/);
  assert.match(src, /startAppDrag/);
  // 启动门文案：Agent 必需权限，不绑死 Chrome
  assert.match(src, /Agent 必需|required for Agent|需要授予 Agent 必需权限/);
  assert.doesNotMatch(src, /Cookie 目录（例如 Chrome）/);
  assert.match(src, /BRAND_LOGO_SRC = '\.\/logo\.png'/);
  assert.match(src, /fda-permission-logo/);
  assert.match(src, /Complete in System Settings|在系统设置中完成/);
  assert.match(src, /apps never auto-appear|列表不会自动出现/);
  assert.match(src, /visibilitychange/);
  assert.match(src, /addEventListener\('focus'/);
  assert.doesNotMatch(src, /from '\.\/Overlay'/);
  assert.match(src, /createPortal/);
  assert.doesNotMatch(src, /在 Finder 中显示 App|Reveal app in Finder|revealAppInFinder/);
  assert.match(src, /getStartupOsPermissions/);
});

test('root renderer wraps App with AppErrorBoundary', () => {
  const mainTsx = readFileSync(join(here, '../../main.tsx'), 'utf8');
  assert.match(mainTsx, /AppErrorBoundary/);
  assert.match(mainTsx, /<AppErrorBoundary>/);
});
