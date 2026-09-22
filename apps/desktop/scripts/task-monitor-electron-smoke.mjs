// Real Electron + production main/renderer, isolated data and profile.
// Seeded conversation history is a fixture; shell runs use the production projection,
// permission and evidence pipeline. Never attaches to the user's app or webview.
import { _electron as electron } from 'playwright-core';
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConversationStore } from '../../../packages/conversation-store/src/index.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'peer-task-monitor-electron-')));
const home = path.join(root, 'data');
const workspace = path.join(root, 'workspace');
await mkdir(workspace, { recursive: true });
await mkdir(home, { recursive: true });
const store = createConversationStore({ storeDir: path.join(home, 'conversations') });
const current = store.createConversation({ title: 'Monitor current fixture', workspacePath: workspace });
const other = store.createConversation({ title: 'Monitor other fixture', workspacePath: workspace });
for (const conversation of [current, other]) store.appendMessage(conversation.id, {
  id: `user-${conversation.id}`, role: 'user', content: conversation.title, timestamp: Date.now(),
});
store.appendMessage(other.id, { id: 'other-history', role: 'assistant', content: 'Seeded tool history for UI acceptance.', timestamp: Date.now(),
  segments: Array.from({ length: 8 }, (_, i) => ({ type: 'tool-call', tool: i === 0 ? 'skill__release-process' : `mcp__fixture__lookup${i}`,
    toolCallId: `fixture-call-${i}`, args: {}, result: 'Fixture result; not a live MCP execution.' })),
});
await mkdir(path.join(home, 'skills/release-process'), { recursive: true });
await writeFile(path.join(home, 'skills/release-process/SKILL.md'), '---\nname: release-process\ndescription: Isolated test skill, never executed.\n---\nFixture only.\n');
await writeFile(path.join(home, 'settings.json'), JSON.stringify({ locale: 'en', theme: 'light', workspacePaths: [workspace] }));
console.log('SMOKE_ROOT', root);
await build({ root: desktop, logLevel: 'warn', build: { outDir: path.join(root, 'renderer'), emptyOutDir: false } });
const mainUrl = (file) => pathToFileURL(path.join(desktop, 'electron/main', file)).href;
const entry = path.join(root, 'entry.mjs');
await writeFile(entry, `import {app} from 'electron';
app.setPath('userData', ${JSON.stringify(path.join(root, 'chromium'))});
app.whenReady().then(async () => {
  await import(${JSON.stringify(mainUrl('main.mjs'))});
  const {executeProjectedModelTool} = await import(${JSON.stringify(mainUrl('chat-runtime/projected-tool-executor.mjs'))});
  const {getApplicationShellTasks, disposeApplicationShellTasks} = await import(${JSON.stringify(mainUrl('runtime-gateway/application-shell-tasks.mjs'))});
  const {disposeApplicationShellSessions} = await import(${JSON.stringify(mainUrl('runtime-gateway/application-shell-sessions.mjs'))});
  let index = 0;
  globalThis.monitorSmoke = {
    exec: (command, conversationId, runInBackground = true) => executeProjectedModelTool({name:'bash',args:{command,runInBackground},workspacePath:${JSON.stringify(workspace)},
      toolCallId:'monitor-smoke-'+(++index),toolContext:{conversationId,mode:'chat'},
      goalPlanStore:{listPlansByConversation:()=>[{status:'executing'}]},
      requestPermission:async()=>({granted:true}),shellApprovalDecider:async()=>({granted:true,reason:'isolated_test'}),locale:'en-US'}),
    list:()=>getApplicationShellTasks(${JSON.stringify(home)}).list(),
    dispose:()=>Promise.all([disposeApplicationShellTasks(${JSON.stringify(home)}),disposeApplicationShellSessions(${JSON.stringify(home)})]),
  };
}).catch(e=>{console.error(e);app.exit(1)});`);
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, PEER_AGENT_HOME: home,
  PEER_AGENT_DISABLE_LEGACY_MIGRATION: '1', VITE_DEV_SERVER_URL: pathToFileURL(path.join(root, 'renderer/index.html')).href };
let app, page;
const errors = [], checks = [], mainLogs = [];
const deadline = setTimeout(() => { console.error('SMOKE_DEADLINE', root); app?.process().kill('SIGTERM'); }, 150000);
const check = (name) => { checks.push(name); console.log('PASS', name); };
try {
  app = await electron.launch({ args: [entry], env, timeout: 20000 });
  app.process().stdout?.on('data', (data) => { /* main logs retained below */ mainLogs.push(data.toString()); });
  app.process().stderr?.on('data', (data) => mainLogs.push(data.toString()));
  const until = Date.now() + 30000;
  while (!page && Date.now() < until) {
    page = app.windows().find((window) => window.url() === env.VITE_DEV_SERVER_URL);
    if (!page) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(page, 'production main window exists');
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const currentRow = page.locator(`[data-conversation-id="${current.id}"]`);
  await currentRow.waitFor();
  const workspaceRow = currentRow.locator('xpath=ancestor::div[contains(@class,"sidebar-workspace-node")][1]').locator('.sidebar-workspace-row').first();
  if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click();
  await currentRow.click();
  await page.locator('.chat-task-monitor-toggle').click();
  const rail = page.locator('.task-monitor-rail');
  await rail.waitFor();
  assert.ok(!(await rail.innerText()).includes('release-process'));
  check('installed but unused release-process absent in current conversation');
  await page.screenshot({ path: path.join(root, '01-unused-skill.png') });
  const openMonitor = async () => {
    const toggle = page.locator('.chat-task-monitor-toggle');
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await rail.waitFor();
  };
  const installed = await page.evaluate(() => window.peerAgent.listSkills());
  assert.ok(installed.some((skill) => skill.name === 'release-process'), 'fixture skill is really installed');
  await page.locator(`[data-conversation-id="${other.id}"]`).click();
  await openMonitor();
  const skills = rail.locator('section[aria-label="Skills & MCP"]');
  await skills.waitFor();
  assert.equal(await skills.locator('.task-monitor-row').count(), 6);
  assert.ok((await skills.innerText()).includes('release-process'));
  await skills.getByRole('button', { name: 'View more (2)' }).click();
  assert.equal(await skills.locator('.task-monitor-row').count(), 8);
  assert.equal(await page.locator('.workbench-panel--open').count(), 0);
  await page.screenshot({ path: path.join(root, '02-used-capabilities-expanded.png') });
  await skills.getByRole('button', { name: 'Show less' }).click();
  assert.equal(await skills.locator('.task-monitor-row').count(), 6);
  await currentRow.click();
  await openMonitor();
  await skills.waitFor({ state: 'detached' });
  check('real conversation switch isolates seeded Skill/MCP calls; expand/collapse stays in section');

  const exec = (command, id, background = true) => app.evaluate(async (_, input) =>
    globalThis.monitorSmoke.exec(input.command, input.id, input.background), { command, id, background });
  const commands = [0, 1, 2].map((index) => `printf 'monitor-run-${index}\\n'; while [ ! -f monitor-finish ]; do sleep 1; done; printf 'monitor-done-${index}\\n'`);
  const results = [];
  for (const command of commands) results.push(await exec(command, current.id));
  results.push(await exec("printf 'other-conversation\\n'; while [ ! -f monitor-finish ]; do sleep 1; done", other.id));
  results.push(await exec("printf 'foreground-finished\\n'", current.id, false));
  await writeFile(path.join(root, 'tool-results.json'), JSON.stringify(results, null, 2));
  const runs = rail.locator('section[aria-label="Background tasks"]');
  await runs.getByRole('button', { name: 'View more (1)' }).waitFor();
  assert.equal(await runs.locator('.task-monitor-row').count(), 2);
  assert.equal(await runs.locator('.task-monitor-row-label').first().innerText(), 'Running');
  assert.ok(!(await runs.innerText()).includes('Model requested bash.'));
  await runs.getByRole('button', { name: 'View more (1)' }).click();
  assert.equal(await runs.locator('.task-monitor-row').count(), 3);
  assert.equal(await page.locator('.workbench-panel--open').count(), 0);
  await runs.locator('.task-monitor-row').first().click();
  await runs.locator('.background-run-detail').waitFor();
  assert.match(await runs.innerText(), /monitor-run-/);
  await page.screenshot({ path: path.join(root, '03-background-expanded-details.png') });
  check('real background commands/status/details shown; foreground and other-conversation excluded');
  const layout = [];
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    await runs.getByRole('button', { name: 'Show less' }).scrollIntoViewIfNeeded();
    const dimensions = await rail.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const body = element.querySelector('.task-monitor-scroll');
      return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth,
        bodyClient: body.clientWidth, bodyScroll: body.scrollWidth };
    });
    assert.ok(dimensions.left >= 0 && dimensions.right <= width + 1 && dimensions.width > 200);
    assert.ok(dimensions.bodyScroll <= dimensions.bodyClient + 1, 'no horizontal overflow');
    for (const row of await runs.locator('.task-monitor-row').all()) {
      assert.ok(await row.locator('.task-monitor-row-label').isVisible());
      assert.ok(await row.locator('.task-monitor-row-value').isVisible());
      const box = await row.locator('.task-monitor-row-value').boundingBox();
      assert.ok(box.width > 70, 'command retains readable width next to status');
    }
    layout.push({ width, ...dimensions });
    await page.screenshot({ path: path.join(root, `05-layout-${width}.png`) });
  }
  await writeFile(path.join(root, 'layout.json'), JSON.stringify(layout, null, 2));
  await page.setViewportSize({ width: 1440, height: 1000 });
  check('1440/1000px windows keep status, command and expansion accessible without horizontal overflow');
  await runs.getByRole('button', { name: 'Show less' }).click();
  assert.equal(await runs.locator('.task-monitor-row').count(), 2);
  await page.locator(`[data-conversation-id="${other.id}"]`).click();
  await openMonitor();
  await runs.locator('.task-monitor-row-value').filter({ hasText: 'other-conversation' }).waitFor();
  assert.equal(await runs.locator('.task-monitor-row').count(), 1);
  assert.equal(await runs.locator('.background-run-detail').count(), 0);
  await currentRow.click();
  await openMonitor();
  await runs.getByRole('button', { name: 'View more (1)' }).waitFor();
  assert.equal(await runs.locator('.background-run-detail').count(), 0);
  check('conversation switch clears selected run details and resets expansion');

  // Release test-owned processes naturally, without changing runtime status by hand.
  await writeFile(path.join(workspace, 'monitor-finish'), 'finish\n');
  await runs.waitFor({ state: 'detached', timeout: 20000 });
  const history = await page.evaluate(() => window.peerAgent.listShellTasks());
  // Foreground execution belongs to the persistent session, not this background registry.
  assert.equal(history.length, 4);
  assert.ok(results.every((result) => result.success && result.execution?.result?.evidence));
  assert.match(results.at(-1).output, /foreground-finished/);
  assert.ok(history.every((task) => task.status === 'success'));
  const own = history.filter((task) => task.conversationId === current.id && task.runInBackground);
  for (const task of own) {
    assert.match(task.stdout, /monitor-done-/);
    assert.ok(task.artifactRef);
    const log = path.join(home, 'shell-artifacts', task.completedAt.slice(0, 10), task.taskId, 'stdout.txt');
    assert.match(await readFile(log, 'utf8'), /monitor-done-/);
  }
  await writeFile(path.join(root, 'history-after-completion.json'), JSON.stringify(history, null, 2));
  await page.screenshot({ path: path.join(root, '04-completed-removed.png') });
  check('completed commands leave live UI after polling, but runtime history and on-disk stdout remain');
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ status: 'passed', root, checks, errors }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, checks }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    await writeFile(path.join(root, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'unavailable'));
  }
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ status: 'failed', root, checks, errors, error: String(error) }, null, 2));
  console.error('SMOKE_FAILURE', root, error);
  throw error;
} finally {
  clearTimeout(deadline);
  if (app) {
    await app.evaluate(async () => globalThis.monitorSmoke?.dispose()).catch(() => {});
    await app.close();
  }
  await writeFile(path.join(root, 'main.log'), mainLogs.join(''));
}
