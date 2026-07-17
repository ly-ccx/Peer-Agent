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

test('brand startup keeps black wordmark, drops liquid-crest, and ink-wash holds loading', async () => {
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

  // 字标填充为深墨黑，而非五彩光谱
  assert.match(loader, /INK_BLACK\s*=\s*'#1a1d21'/);
  assert.match(loader, /brand-startup-loader__wordmark--ink/);
  assert.doesNotMatch(loader, /#5f7db8/);
  assert.doesNotMatch(loader, /#b87898/);
  assert.doesNotMatch(loader, /attributeName="gradientTransform"/);
  assert.doesNotMatch(loader, /allowColorFlow/);

  // 入场停住后：背景水墨颜料散开加载态（必须肉眼可见，禁止再冲淡到看不见）
  assert.match(loader, /brand-startup-loader__ink-wash/);
  assert.match(loader, /brand-startup-loader__ink-blot/);
  assert.match(shellCss, /brand-startup-loader__ink-wash/);
  assert.match(shellCss, /brand-startup-ink-wash 6\.4s/);
  assert.match(shellCss, /\.brand-startup-loader__ink-blot[\s\S]*filter:\s*blur\(28px\)/);
  assert.doesNotMatch(shellCss, /mix-blend-mode:\s*multiply/);
  assert.match(motionCss, /@keyframes brand-startup-ink-wash/);
  // 峰值透明度足够高（≥0.8），否则浅底 + 模糊会看不见
  assert.match(motionCss, /opacity:\s*0\.88/);
  // 墨渍本体 alpha 足够深
  assert.match(shellCss, /rgba\(22,\s*24,\s*30,\s*0\.78\)/);
  assert.match(shellCss, /rgba\(28,\s*32,\s*42,\s*0\.72\)/);
  assert.match(shellCss, /rgba\(18,\s*20,\s*26,\s*0\.7\)/);

  assert.match(
    shellCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.brand-startup-loader__brand[\s\S]*animation:\s*none/,
  );
  assert.match(
    shellCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.brand-startup-loader__ink-blot[\s\S]*animation:\s*none/,
  );
  // reduced-motion 静态墨渍也必须可见
  assert.match(
    shellCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.brand-startup-loader__ink-blot[\s\S]*opacity:\s*\.62/,
  );
});
