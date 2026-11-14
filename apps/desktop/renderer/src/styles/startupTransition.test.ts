import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRendererSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('desktop bootstrap publishes session early and preloads workspace snapshot in background', async () => {
  const bootstrap = await readRendererSource('../app/state/useDesktopBootstrap.ts');

  assert.match(bootstrap, /useResourceRead/);
  assert.match(bootstrap, /await clientApi\.workspaceList\(\)/);
  assert.match(bootstrap, /clientApi\.workspaceInfo/);
  assert.match(bootstrap, /clientApi\.conversationsList/);
  assert.match(bootstrap, /Optional warmup cannot turn a usable bootstrap into a failure/);
});

test('App and Sidebar consume the startup snapshot on their first render', async () => {
  const [app, sidebar] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('../chat/components/Sidebar.tsx'),
  ]);

  assert.match(app, /startupSnapshot\?\.conversations/);
  assert.match(app, /startupSnapshot\?\.activeWorkspace/);
  assert.match(app, /startupSnapshot=\{startupSnapshot\}/);
  assert.match(sidebar, /startupSnapshot\?\.workspaces/);
  assert.match(sidebar, /startupSnapshot\?\.workspaceInfo/);
});

test('desktop startup has no delayed hidden layout reveal', async () => {
  const [app, sidebarCss] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('./sidebar.css'),
  ]);

  // 禁止：隐藏壳层后 setTimeout 再 reveal 的假启动（450ms 那套）
  assert.doesNotMatch(app, /450|isInitialWorkspaceReady|app-layout-initializing|app-layout-ready/);
  assert.doesNotMatch(sidebarCss, /app-layout-initializing|app-layout-ready/);
  // 内容就绪不因品牌动画阻塞主壳挂载。
  assert.doesNotMatch(app, /BRAND_STARTUP_INTRO_MS|app-layout-initializing/);
});

test('bootstrap uses the kitten silhouette loader and perspective reveal without exposing initialization details', async () => {
  const [app, loader] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('../app/components/BrandStartupLoader.tsx'),
  ]);

  assert.doesNotMatch(app, /useBrandStartupMinHold/);
  assert.match(app, /showMainShell/);
  assert.match(app, /showStartupLoader \? <BrandStartupLoader ready=\{showMainShell\}/);
  assert.match(app, /startup-reveal-layer/);
  assert.match(loader, /brand-startup-loader__cat-silhouette/);
  assert.match(loader, /brand-startup-loader__portal/);
  assert.match(loader, /brand-startup-loader__scrim/);
  assert.match(loader, /fillRule="evenodd"/);
  assert.doesNotMatch(loader, /progress|workspace|conversation|capabilit/i);
});

test('branded startup motion has a reduced-motion fallback and the old progress track is gone', async () => {
  const shellCss = await readRendererSource('./shell.css');

  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shellCss, /brand-startup-loader__brand/);
  assert.match(shellCss, /brand-startup-loader__portal/);
  assert.doesNotMatch(shellCss, /\.bootstrap-loader(?:-copy|-label|-track)?\b/);
});

test('brand startup uses bouncy kitten silhouette entrance and cutout perspective reveal with Frost tokens', async () => {
  const shellCss = await readRendererSource('./shell.css');
  const motionCss = await readRendererSource('./motion.css');
  const loader = await readRendererSource('../app/components/BrandStartupLoader.tsx');

  // Phase 1: 中心小猫剪影 Q 弹入场 + 柔和呼吸待机
  assert.match(shellCss, /animation:\s*brand-startup-cat-bounce 560ms/);
  assert.match(shellCss, /animation:\s*brand-startup-cat-idle 2\.2s/);
  assert.match(motionCss, /@keyframes brand-startup-cat-bounce/);
  assert.match(motionCss, /@keyframes brand-startup-cat-idle/);

  // 去掉旧的 Peer Agent 文字填充与黄色底线
  assert.doesNotMatch(loader, /brand-startup-loader__wordmark/);
  assert.doesNotMatch(loader, /brand-startup-loader__fill-mask/);
  assert.doesNotMatch(loader, /brand-startup-loader__support/);
  assert.doesNotMatch(motionCss, /@keyframes brand-startup-fill/);
  assert.doesNotMatch(motionCss, /@keyframes brand-startup-support/);
  assert.doesNotMatch(shellCss, /#eabf58/);

  // 使用 Frost 语义 token，无流体泼墨引擎
  assert.match(shellCss, /fill:\s*var\(--graphite-base\)/);
  assert.match(shellCss, /fill:\s*var\(--za-app-bg\)/);
  assert.doesNotMatch(loader, /getContext\('2d'/);
  assert.doesNotMatch(loader, /startInkWash/);
  assert.doesNotMatch(shellCss, /brand-startup-loader__ink-canvas/);

  // Phase 2: 透视放大揭示可被交互及 reduced-motion 中断
  assert.match(loader, /export function BrandStartupLoader/);
  assert.match(loader, /prefersReducedMotion/);
  assert.match(loader, /pointerdown/);
  assert.match(loader, /keydown/);

  assert.match(
    shellCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.brand-startup-loader__brand[\s\S]*animation:\s*none/,
  );
});

test('startup readiness does not block main shell mount and bootstrap failures offer a retry', async () => {
  const app = await readRendererSource('../App.tsx');
  assert.match(app, /showMainShell = Boolean\(session\)/);
  assert.doesNotMatch(app, /brandStartupHoldDone|useBrandStartupMinHold|BRAND_STARTUP_INTRO_MS/);
  assert.match(app, /initError \? <ResourceFeedback[\s\S]*onReload=\{refreshBootstrap\}/);
});
