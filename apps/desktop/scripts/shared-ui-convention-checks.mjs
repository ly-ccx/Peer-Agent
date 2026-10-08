import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore } from '@peer-agent/runtime-node';
import { createAutomationStore } from '../electron/main/automation-store.mjs';

export const sharedUiShots = ['diagnostics', 'appearance', 'automation-list', 'automation-receipt', 'automation-editor', 'classic-chat', 'classic-image-lightbox', 'classic-artifacts', 'classic-diff']
  .flatMap(scene => [`ui-${scene}-1280-dark.png`, `ui-${scene}-760-light.png`]);

export function seedUiAutomation({ home, workspacePath }) {
  const store = createAutomationStore({ storeDir: path.join(home, 'automations') });
  const now = '2026-10-01T01:00:00.000Z';
  const definition = store.createDefinition({ name: 'UI 规范回归', prompt: '核对界面层级与键盘操作。', workspacePath,
    status: 'paused', schedule: { kind: 'daily', timezone: 'Asia/Shanghai', hour: 9, minute: 0 },
    grant: { preset: 'observe', workspacePath, allowedCapabilityIds: [], askCapabilityIds: [], blockedCapabilityIds: [], confirmedAt: now, version: 1 },
    notifications: { needsAttention: 'badge', failed: false, succeeded: false }, budget: { timeoutMs: 60000 },
    missedRunPolicy: 'skip', overlapPolicy: 'skip' }, { automationId: 'rc-ui-conventions', now });
  store.createRun({ automationId: definition.automationId, idempotencyKey: 'rc-ui-conventions:receipt', triggerSource: 'manual',
    status: 'succeeded', scheduledAt: now, startedAt: now, finishedAt: now,
    snapshot: { definitionVersion: definition.version, name: definition.name, prompt: definition.prompt, workspacePath,
      schedule: definition.schedule, grant: definition.grant, budget: definition.budget },
    receipt: { summary: '已核对两种主题中的控件层级。', previousSummary: '上次已核对消息与来源引用的边界。',
      comparisonSummary: '新增键盘披露与窄窗口检查。', resultChanged: true, verifications: [], evidenceRefs: [], durationMs: 1200 },
  }, { runId: 'rc-ui-conventions-receipt', now });
}

export function seedClassicUiFixture({ home }) {
  const workspacePath = path.join(home, 'ui-classic-workspace');
  mkdirSync(workspacePath);
  const git = args => execFileSync('git', ['-C', workspacePath, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  const content = Array.from({ length: 20 }, (_, i) => `export const item${i} = ${i};`).join('\n') + '\n';
  writeFileSync(path.join(workspacePath, 'old-name.ts'), content);
  // A wide image with four colored corners exposes accidental ellipse clipping.
  writeFileSync(path.join(workspacePath, 'preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAABxElEQVR42u3VsQ1AQBiGYSemUGMAnV5tACsYQAyjl1hFVDqG0euvwPMMcJd8yZs/bFOfxLQWXQJ/NVRH1PdTE8N7CRgEDAgYEDAIGBAwIGBAwCBgQMCAgEHAgIABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgIABAcPbhXFerAAuMCBgQMAgYEDAgIABAYOAAQEDAgYBAwIGBAwIGAQMCBgQMCBgEDAgYEDAIGBAwICAAQGDgAEBAwIGBAwCBgQMCBgEDAgYEDAgYBAwIGBAwCBgQMCAgAEBg4ABAQMCBgQMAgYEDAgYBAwIGBAwIGAQMCBgQMCAgEHAgIABAYOAAQEDAgYEDAIGBAwIGARsAhAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYBAwIGBAwIGAQMCBgQMAgYEDAgIABAYOAAQEDAgYEDAIGBAwIGAQMCBgQMCBgEDAgYEDAIGBAwICAAQGDgAEBAwIGnrJrP6N+UNSllfmttsldYEDAIGBAwICAQcCAgAEBAwIGAQMCBgQMCBgEDAgYEDAIGBAwIGBAwCBgQMCAgAEBg4ABAQMCBgEDAgYEDAgYvukG710K3Y1DwUgAAAAASUVORK5CYII=', 'base64'));
  git(['add', '.']);
  const commit = message => git(['-c', 'user.name=UI Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]);
  commit('fixture base');
  const baseCommit = git(['rev-parse', 'HEAD']);
  git(['mv', 'old-name.ts', 'new-name.ts']);
  writeFileSync(path.join(workspacePath, 'new-name.ts'), content.replace('item0 = 0', 'item0 = 100'));
  git(['add', '.']); commit('fixture rename');
  const conversations = createConversationStore({ storeDir: path.join(home, 'conversations') });
  const conversation = conversations.createConversation({ title: 'UI 规范回归 · 经典聊天', workspacePath });
  conversations.appendMessage(conversation.id, { id: 'rc-ui-classic-user', role: 'user', content: '整理文件命名，并说明改动。', timestamp: Date.now() });
  conversations.appendMessage(conversation.id, { id: 'rc-ui-classic-reply', role: 'assistant', content: '文件已改名为 `new-name.ts`，保留现有内容并调整第一项。\n\n本地图片：`./preview.png`\n\n请在查看进度中核对文件对照。', timestamp: Date.now() });
  const plans = createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') });
  const evidenceRef = 'rc-ui-classic-evidence';
  const plan = plans.createPlan({ conversationId: conversation.id, title: 'UI 规范回归 · 文件命名', goal: '整理文件命名。', status: 'completed',
    originWorkspacePath: workspacePath, targetWorkspacePath: workspacePath, baseCommit,
    tasks: [{ taskId: 'rc-ui-rename', title: '整理文件命名', status: 'completed', evidenceRefs: [evidenceRef] }],
    evidenceRefs: [evidenceRef], deliveryBinding: { repoId: 'rc-ui-fixture', targetBranch: 'main', targetBranchSource: 'workspace_head',
      targetWorkspacePath: workspacePath, baseCommit, taskBranch: 'main', executionIsolation: 'none' } });
  const diff = git(['diff', '--find-renames', baseCommit, 'HEAD']);
  plans.recordEvidenceRefs({ planId: plan.planId, conversationId: conversation.id, evidenceRef,
    userArtifacts: [{ kind: 'code-change', ref: pathToFileURL(path.join(workspacePath, 'new-name.ts')).href,
      path: path.join(workspacePath, 'new-name.ts'), label: 'new-name.ts',
      preview: { kind: 'code', additions: 1, deletions: 1, diffLines: diff.split('\n') } }] });
  return { workspacePath, conversationId: conversation.id, diff };
}

/** Inactive legacy surfaces: bundle the actual components without adding a product route. */
async function buildLegacyComponentFixture({ captureDirectory, classicFixture }) {
  const { build } = await import('vite');
  const desktop = fileURLToPath(new URL('..', import.meta.url));
  const output = path.join(captureDirectory, 'legacy-components');
  const entryId = '\0ui-convention-fixture';
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ArtifactList } from './renderer/src/app/pages/TaskOverviewPage.tsx';
    import { DiffViewer } from './renderer/src/workbench/file-preview/DiffViewer.tsx';
    import './renderer/src/styles.css';
    const artifact = { kind: 'code', ref: 'file:///fixture/new-name.ts', openPath: '/fixture/new-name.ts',
      label: 'new-name.ts', preview: { kind: 'code', additions: 1, deletions: 1 } };
    const item = { planSteps: [{ artifacts: [artifact] }] };
    createRoot(document.getElementById('root')).render(React.createElement('main',
      { className: 'task-overview-work-item', style: { margin: '32px', padding: '24px' } },
      React.createElement('h2', null, '生产组件隔离夹具'),
      React.createElement('p', null, '旧产物披露与 Diff 索引；不代表当前任务流程可达。'),
      React.createElement(ArtifactList, { item }),
      React.createElement('h3', null, '重命名文件对照'),
      React.createElement(DiffViewer, { diffText: ${JSON.stringify(classicFixture.diff)}, showFileIndex: true, isZh: true }),
      React.createElement(DiffViewer, { diffText: ${JSON.stringify(classicFixture.diff)}, isZh: true })));
  `;
  await build({ root: desktop, configFile: path.join(desktop, 'vite.config.ts'), logLevel: 'error',
    plugins: [{
      name: 'ui-convention-isolated-components',
      resolveId(id, importer) {
        if (id === entryId) return entryId;
        if (importer === entryId && id.startsWith('./')) return path.resolve(desktop, id);
      },
      load(id) { if (id === entryId) return entry; },
      transform(code, id) {
        if (id.endsWith('/TaskOverviewPage.tsx')) {
          assert.equal(code.split('function ArtifactList(').length, 2, 'one production ArtifactList seam');
          return code + '\nexport { ArtifactList };';
        }
      },
    }],
    build: { outDir: output, emptyOutDir: true, rollupOptions: { input: entryId,
      output: { entryFileNames: 'fixture.js' } } },
  });
  const css = readdirSync(path.join(output, 'assets')).filter(file => file.endsWith('.css'))
    .map(file => `<link rel="stylesheet" href="./assets/${file}">`).join('');
  // The fixture has no production App shell to constrain the desktop body's
  // minimum width. Its host must fit the requested viewport, like the real shell.
  writeFileSync(path.join(output, 'index.html'), `<!doctype html><html data-theme="dark"><meta charset="utf-8">${css}<style>body{min-width:0}</style><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  return pathToFileURL(path.join(output, 'index.html')).href;
}

/** Production components and isolated stores; no real scheduling or model requests. */
export async function checkSharedUiConventions({ page, app, report, captureDirectory, classicFixture }) {
  const cases = [];
  // Establish the viewport before focusing an offscreen disclosure. Otherwise
  // Chromium may retain a document scroll from the initial, shorter window.
  await page.setViewportSize({ width: 1280, height: 900 });
  async function layouts(scene, check) {
    for (const [width, theme] of [[1280, 'dark'], [760, 'light']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      if (check) await check();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => document.documentElement.getBoundingClientRect().top === 0
        && document.getElementById('root')?.scrollTop === 0
        && (document.querySelector('.app-shell')?.scrollTop ?? 0) === 0), true,
        'the capture must not crop a scrolled root document');
      await page.screenshot({ animations: 'disabled', path: path.join(captureDirectory, `ui-${scene}-${width}-${theme}.png`) });
      cases.push({ scene, width, theme });
    }
  }
  const nav = page.locator('.settings-nav');
  const preview = page.locator('.project-diagnostics summary');
  await preview.focus(); await page.keyboard.press('Enter');
  assert.equal(await preview.locator('svg').count(), 1);
  assert.equal(await preview.evaluate(node => node.parentElement.open), true);
  await layouts('diagnostics', async () => {
    await preview.focus();
    assert.equal(await preview.evaluate(node => getComputedStyle(node).listStyleType), 'none');
    assert.equal(await preview.evaluate(node => node === document.activeElement), true);
  });
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await layouts('appearance', async () => {
    const radii = await page.locator('.appearance-mode-thumb').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderRadius));
    assert.deepEqual(radii, ['8px', '8px', '8px'], 'rectangular theme previews must retain their corners');
  });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.bot-app-menu-button').click();
  await page.getByRole('menuitem', { name: '自动化', exact: true }).click();
  await page.locator('.automation-list-row').filter({ hasText: 'UI 规范回归' }).waitFor();
  await layouts('automation-list');
  await page.locator('.automation-list-row').filter({ hasText: 'UI 规范回归' }).click();
  await page.locator('.automation-latest-result').click();
  const summary = page.locator('.automation-comparison summary');
  await summary.focus(); await page.keyboard.press('Enter');
  assert.equal(await summary.evaluate(node => node.parentElement.open), true);
  assert.equal(await summary.locator('svg').count(), 1);
  await layouts('automation-receipt', async () => { await summary.focus(); });
  await page.locator('.automation-back').click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.automation-select select').waitFor();
  await layouts('automation-editor', async () => {
    const select = page.locator('.automation-select select').first();
    assert.equal(await select.evaluate(node => getComputedStyle(node).appearance), 'none');
    assert.equal(await select.locator('..').locator('svg').count(), 1);
    const typography = node => {
      const style = getComputedStyle(node);
      return { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color };
    };
    assert.deepEqual(await select.evaluate(typography),
      await page.locator('.automation-field input').first().evaluate(typography));
    await select.focus();
    assert.equal(await select.evaluate(node => node === document.activeElement), true);
  });
  await page.locator('.bot-app-menu-button').click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await page.getByRole('button', { name: '界面', exact: true }).click();
  await page.getByRole('option', { name: '经典界面', exact: true }).click();
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.app-sidebar').waitFor();
  const group = page.locator('.sidebar-workspace-row').filter({ hasText: 'UI 规范回归' }).first();
  if (await group.getAttribute('aria-expanded') === 'false') await group.locator('.sidebar-workspace-chevron-btn').click();
  const conversation = page.locator(`[data-conversation-id="${classicFixture.conversationId}"]`).first();
  await conversation.click();
  await page.getByText('文件已改名为', { exact: false }).waitFor();
  const image = page.locator('.markdown-local-image-thumb');
  await image.waitFor();
  await page.waitForFunction(() => document.querySelector('.markdown-local-image-thumb img')?.naturalWidth === 320);
  await layouts('classic-chat', async () => {
    assert.equal(await image.evaluate(node => getComputedStyle(node).borderRadius), '8px');
    assert.equal(await image.locator('img').evaluate(node => node.naturalHeight), 180);
  });
  await layouts('classic-image-lightbox', async () => {
    if (await page.locator('.markdown-local-image-lightbox').isVisible()) await page.keyboard.press('Escape');
    await page.locator('.markdown-local-image-lightbox').waitFor({ state: 'hidden' });
    await image.focus(); await page.keyboard.press('Enter');
    await page.locator('.markdown-local-image-lightbox-stage img').waitFor();
    assert.equal(await page.locator('.markdown-local-image-lightbox-stage img').evaluate(node => node.naturalWidth), 320);
    assert.equal(await page.locator('.markdown-local-image-lightbox-panel').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
    }), true);
  });
  await page.keyboard.press('Escape');
  await page.locator('.markdown-local-image-lightbox').waitFor({ state: 'hidden' });
  const fixtureUrl = await buildLegacyComponentFixture({ captureDirectory, classicFixture });
  const componentWindow = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ width: 1280, height: 900, show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    void window.loadURL(url);
  }, fixtureUrl);
  page = await componentWindow;
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const artifacts = page.locator('.task-artifacts-summary');
  await artifacts.focus(); await page.keyboard.press('Enter');
  assert.equal(await artifacts.locator('svg').count(), 1);
  assert.equal(await artifacts.evaluate(node => node.parentElement.open), true);
  await layouts('classic-artifacts', async () => {
    await artifacts.focus();
    await page.locator('.task-artifact-name').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const details = document.querySelector('.task-artifacts');
      const row = details.querySelector('.task-artifact').getBoundingClientRect();
      const outer = details.getBoundingClientRect();
      return row.bottom < outer.bottom && outer.right <= window.innerWidth
        && details.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running');
    });
  });
  const file = page.locator('.diff-file-index-row').filter({ hasText: 'new-name.ts' });
  await file.waitFor();
  await layouts('classic-diff', async () => {
    await file.evaluate(node => node.blur());
    await file.focus();
    await page.locator('.diff-file-preview .diff-rename-arrow').waitFor();
    assert.equal(await page.locator('.diff-file-preview .diff-rename-source').textContent(), 'old-name.ts');
    assert.equal(await page.locator('.diff-file-preview-portal').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
    }), true);
  });
  report.sharedUiConventions = { keyboardDisclosure: true, svgSelect: true, rectangularPreviews: true, keyboardImagePreview: true, cases,
    limits: 'Source Electron and isolated stores; paused automation receipt. Legacy artifact/Diff shots mount production components in an isolated fixture because current Goal projection no longer emits result_ready. Keyboard focus/activation checked; no OS picker, screen reader or installed build.' };
}
