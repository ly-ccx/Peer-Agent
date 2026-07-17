import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRendererSource = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('desktop bootstrap preloads a complete workspace snapshot before publishing the session', async () => {
  const bootstrap = await readRendererSource('../app/state/useDesktopBootstrap.ts');

  assert.match(bootstrap, /await clientApi\.workspaceList\(\)/);
  assert.match(bootstrap, /clientApi\.workspaceInfo/);
  assert.match(bootstrap, /clientApi\.conversationsList/);
  assert.ok(bootstrap.indexOf('setStartupSnapshot(nextSnapshot)') < bootstrap.indexOf('setSession(bootstrap.session)'));
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

test('desktop startup has no delayed hidden reveal', async () => {
  const [app, sidebarCss] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('./sidebar.css'),
  ]);

  assert.doesNotMatch(app, /450|isInitialWorkspaceReady|app-layout-initializing|app-layout-ready|setTimeout/);
  assert.doesNotMatch(sidebarCss, /app-layout-initializing|app-layout-ready/);
});

test('bootstrap uses the branded wordmark loader without exposing initialization details', async () => {
  const [app, loader] = await Promise.all([
    readRendererSource('../App.tsx'),
    readRendererSource('../app/components/BrandStartupLoader.tsx'),
  ]);

  assert.match(app, /!session && !initError \? <BrandStartupLoader \/>/);
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

  // 入场后字标定住；无呼吸 hold
  assert.match(shellCss, /animation:\s*brand-startup-arrive 3\.2s/);
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
