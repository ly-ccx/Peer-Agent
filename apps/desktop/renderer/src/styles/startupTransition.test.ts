import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRendererSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('desktop bootstrap publishes session early and preloads workspace snapshot in background', async () => {
  const bootstrap = await readRendererSource('../app/state/useDesktopBootstrap.ts');

  assert.match(bootstrap, /setSession\(bootstrap\.session\)/);
  assert.match(bootstrap, /await clientApi\.workspaceList\(\)/);
  assert.match(bootstrap, /clientApi\.workspaceInfo/);
  assert.match(bootstrap, /clientApi\.conversationsList/);
  // 冷启动：session 先发布；snapshot 后台填充（LOGO 最短展示由 useBrandStartupMinHold 保证）
  assert.ok(bootstrap.indexOf('setSession(bootstrap.session)') < bootstrap.indexOf('clientApi.workspaceList'));
  assert.match(bootstrap, /catch \{[\s\S]*normal background refresh paths/);
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
  // 允许：会话列表防抖 setTimeout、品牌最短展示（在独立 hook 中）
  // 品牌最短展示不得写回 App.tsx 的 hidden layout 路径
  assert.doesNotMatch(app, /BRAND_STARTUP_INTRO_MS|app-layout-initializing/);
});

test('bootstrap uses the branded wordmark loader without exposing initialization details', async () => {
  const [app, loader] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('../app/components/BrandStartupLoader.tsx'),
  ]);

  assert.match(app, /useBrandStartupMinHold/);
  assert.match(app, /showMainShell/);
  assert.match(app, /!initError \? <BrandStartupLoader \/>/);
  assert.match(app, /BrandStartupLoader/);
  assert.match(loader, /getBBox\(\)/);
  assert.match(loader, /brand-startup-loader__fill-mask/);
  assert.match(loader, /brand-startup-loader__support/);
  assert.doesNotMatch(loader, /progress|workspace|conversation|capabilit/i);
});

test('branded startup motion has a reduced-motion fallback and the old progress track is gone', async () => {
  const shellCss = await readRendererSource('./shell.css');

  assert.match(shellCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shellCss, /brand-startup-loader__fill-mask/);
  assert.match(shellCss, /brand-startup-loader__support/);
  assert.doesNotMatch(shellCss, /\.bootstrap-loader(?:-copy|-label|-track)?\b/);
});

test('brand startup is pure wordmark with theme-aware ink and no fluid wash', async () => {
  const shellCss = await readRendererSource('./shell.css');
  const motionCss = await readRendererSource('./motion.css');
  const loader = await readRendererSource('../app/components/BrandStartupLoader.tsx');

  // 入场后字标定住；无呼吸 hold；2.2s 字标填充 + 黄线（无扫光）
  assert.match(shellCss, /animation:\s*brand-startup-arrive 2\.2s/);
  assert.match(shellCss, /animation:\s*brand-startup-fill 2\.2s/);
  assert.match(shellCss, /animation:\s*brand-startup-support 2\.2s/);
  assert.doesNotMatch(motionCss, /scale\(1\.018\)/);
  assert.doesNotMatch(motionCss, /translateY\(-30px\)/);
  assert.doesNotMatch(motionCss, /translateY\(-35px\)/);
  // 去掉 liquid-edge 扫光节点与 edge 关键帧
  assert.doesNotMatch(loader, /liquid-edge/);
  assert.doesNotMatch(shellCss, /brand-startup-loader__liquid-edge/);
  assert.doesNotMatch(motionCss, /@keyframes brand-startup-edge/);
  assert.doesNotMatch(shellCss, /animation:\s*brand-startup-edge/);
  // 黄线在填充后出现（support 从约 50% 起）
  assert.match(motionCss, /@keyframes brand-startup-support[\s\S]*0%, 50%/);
  assert.doesNotMatch(shellCss, /brand-startup-arrive-hold/);
  assert.doesNotMatch(motionCss, /@keyframes brand-startup-arrive-hold/);

  // 去掉从下往上的 liquid-crest 尖峰箭头
  assert.doesNotMatch(loader, /liquid-crest/);
  assert.doesNotMatch(shellCss, /liquid-crest/);
  assert.doesNotMatch(motionCss, /@keyframes brand-startup-crest/);

  // 字标填充：浅色深墨 / 深色浅墨，跟随 data-theme
  assert.match(loader, /INK_BLACK\s*=\s*'#1a1d21'/);
  assert.match(loader, /INK_LIGHT\s*=\s*'#d7dde8'/);
  assert.match(loader, /brand-startup-loader__wordmark--ink/);
  assert.match(loader, /readThemeMode/);
  assert.match(loader, /data-theme/);
  assert.doesNotMatch(loader, /#5f7db8/);
  assert.doesNotMatch(loader, /#b87898/);
  assert.doesNotMatch(loader, /attributeName="gradientTransform"/);
  assert.doesNotMatch(loader, /allowColorFlow/);

  // 纯字标：无 canvas 流体泼墨 / 密度场引擎
  assert.doesNotMatch(loader, /brand-startup-loader__ink-canvas/);
  assert.doesNotMatch(loader, /data-ink-wash/);
  assert.doesNotMatch(loader, /getContext\('2d'/);
  assert.doesNotMatch(loader, /startInkWash/);
  assert.doesNotMatch(loader, /randomDrop/);
  assert.doesNotMatch(loader, /function splat/);
  assert.doesNotMatch(loader, /AUTO_MIN_MS/);
  assert.doesNotMatch(loader, /AUTO_MAX_MS/);
  assert.doesNotMatch(loader, /DEN_DISSIPATION/);
  assert.doesNotMatch(loader, /DIFFUSION/);
  assert.doesNotMatch(loader, /velocityStep/);
  assert.doesNotMatch(loader, /densityStep/);
  assert.doesNotMatch(loader, /renderDensity/);
  assert.doesNotMatch(loader, /InkFilament/);
  assert.doesNotMatch(loader, /curlNoise/);
  assert.doesNotMatch(loader, /burstDrop/);
  assert.doesNotMatch(loader, /stampRibbon/);
  assert.doesNotMatch(loader, /InkPuff/);
  assert.doesNotMatch(loader, /drawInkPuff/);
  assert.doesNotMatch(loader, /InkParticle/);
  assert.doesNotMatch(shellCss, /brand-startup-loader__ink-canvas/);
  assert.doesNotMatch(loader, /ink-blot/);
  assert.doesNotMatch(shellCss, /ink-blot/);
  assert.doesNotMatch(shellCss, /brand-startup-ink-wash/);
  assert.doesNotMatch(motionCss, /@keyframes brand-startup-ink-wash/);
  assert.doesNotMatch(shellCss, /mix-blend-mode:\s*multiply/);

  // 仍可渲染字标与支撑线
  assert.match(loader, /export function BrandStartupLoader/);
  assert.match(loader, /Peer Agent/);
  assert.match(loader, /brand-startup-loader__support/);
  assert.match(loader, /getBBox\(\)/);

  assert.match(
    shellCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.brand-startup-loader__brand[\s\S]*animation:\s*none/,
  );
});

test('brand startup min hold keeps LOGO intro for the full 2.2s animation', async () => {
  const [app, hold] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('../app/state/useBrandStartupMinHold.ts'),
  ]);

  assert.match(hold, /export const BRAND_STARTUP_INTRO_MS = 2200/);
  assert.match(hold, /useBrandStartupMinHold/);
  assert.match(hold, /prefers-reduced-motion/);
  assert.match(hold, /setTimeout/);
  // App 门闩：session 就绪也要等品牌最短展示
  assert.match(app, /showMainShell = Boolean\(session\) && brandStartupHoldDone/);
  assert.match(app, /!initError \? <BrandStartupLoader \/>/);
  // 最短展示逻辑不写在 App.tsx 里，避免和「无 delayed reveal」门禁冲突
  assert.doesNotMatch(app, /BRAND_STARTUP_INTRO_MS/);
});
