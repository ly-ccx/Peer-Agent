/** Actual release-tag data compatibility; all writes confined to mkdtemp roots. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '../packages/protocol/node_modules/typescript/lib/typescript.js';
import { createConversationStore } from '../packages/conversation-store/dist/index.mjs';
import { createGoalPlanStore, createAutomationStore, createProjectRegistry, createBotProfileStore,
  createMemoryStore, createObjectiveStore, createInputQueue, loadMigratedSettings } from '../packages/runtime-node/dist/index.js';
import { createTaggedSource } from './rc-tagged-source.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const entries = ['apps/desktop/electron/main/settings-store.mjs', 'packages/conversation-store/src/index.mjs',
  'apps/desktop/electron/main/workspace-application-service.mjs', 'packages/runtime-node/src/goal-plan-store.mjs',
  'packages/runtime-node/src/automation-store.mjs'];
const betas = Array.from({ length: 5 }, (_, i) => `v0.1.0-beta.${i + 1}`);
const candidateVersion = readFileSync(path.join(repository, 'VERSION'), 'utf8').trim();
const updaterVersions = [...new Set([...betas.map(ref => ref.slice(1)), '0.1.0-rc.1', '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.4', '0.1.0-rc.5', candidateVersion])];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tree(root) {
  const result = {};
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const row of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, row.name);
      if (row.isDirectory()) walk(file); else result[path.relative(root, file)] = digest(readFileSync(file));
    }
  }
  walk(root); return result;
}
function verifyFiles(root, hashes) {
  for (const [file, hash] of Object.entries(hashes)) assert.equal(digest(readFileSync(path.join(root, file))), hash, `preserved ${file}`);
}
function recovery(root, phase = '') {
  const source = path.join(repository, 'apps/desktop/electron/main/project-agent/test-fixtures/recovery-crash-child.mjs');
  return new Promise((resolve, reject) => {
    const child = fork(source, [root, phase], { env: { ...process.env, PEER_AGENT_HOME: root }, stdio: ['ignore','ignore','pipe','ipc'] });
    let stderr = '', killed = false, result;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error(`Recovery fixture timeout: ${stderr}`)); }, 12000);
    child.stderr.on('data', data => { stderr += data; });
    child.on('message', message => {
      if (phase && message.checkpoint === phase) { killed = true; child.kill('SIGKILL'); }
      else if (message.done) result = message;
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (killed && signal === 'SIGKILL') resolve({ killed: true });
      else if (code === 0 && result) resolve(result);
      else reject(Error(`Recovery fixture exit ${code}/${signal}: ${stderr}`));
    });
  });
}
async function updater(version, preference = 'auto', stableVersion = '0.1.0') {
  const source = path.join(repository, 'apps/desktop/electron/main/auto-updater.mjs');
  const raw = readFileSync(source, 'utf8');
  const helpers = new Map();
  for (const name of ['release-page-url','update-download-stall','update-check-schedule','update-version','updater-phase','update-github-provider']) {
    helpers.set(`./${name}.mjs`, await import(pathToFileURL(path.join(path.dirname(source), name + '.mjs')).href));
  }
  const app = new EventEmitter(); Object.assign(app, { isPackaged: true, getVersion: () => version });
  const feed = new EventEmitter(), calls = [];
  Object.assign(feed, { configOnDisk: { value: Promise.resolve({ provider: 'generic' }) },
    async checkForUpdates() { calls.push(feed.channel); return { updateInfo: { version: feed.channel === 'latest' ? stableVersion : version } }; },
    downloadUpdate() { throw Error('Unapproved download'); }, quitAndInstall() { throw Error('Unapproved install'); } });
  const module = { exports: {} };
  const code = ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    if (name === 'electron') return { app, shell: {} };
    if (name === 'electron-updater') return { autoUpdater: feed };
    if (helpers.has(name)) return helpers.get(name);
    throw Error(`Unexpected updater import ${name}`);
  }, process: { env: {} }, console: { log() {}, warn() {}, error() {} },
  setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {} }, { filename: source });
  module.exports.initAutoUpdater({ getPreference: () => preference });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const status = module.exports.getUpdaterStatus(); module.exports.stopAutoUpdater();
  return { status, calls, autoDownload: feed.autoDownload };
}

export async function runUpgradeMatrix({ output, includeRecovery = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-rc-upgrade-'));
  const report = { schemaVersion: 1, installed: false, synthetic: true, scope: 'Actual immutable tagged data modules; controlled updater feed and real SIGKILL/recovery with scripted cognition. Installed clients tested separately.',
    startedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse','HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status','--porcelain'], { cwd: repository, encoding: 'utf8' }).trim()), checks: [], tags: [] };
  const modules = new Map();
  const check = async (name, fn) => { const start = Date.now(); try { const details = await fn(); report.checks.push({ name, ok: true, durationMs: Date.now() - start, ...(details ? { details } : {}) }); }
    catch (error) { report.checks.push({ name, ok: false, durationMs: Date.now() - start, error: String(error.message).split(root).join('<fixture>') }); } };
  try {
    for (const ref of ['v0.0.18', ...betas]) {
      const tagged = createTaggedSource({ repository, ref, directory: path.join(root, 'sources', ref) });
      tagged.prepare(entries);
      const [settings, conversations, workspace, goals, automations] = await Promise.all(entries.map(entry => tagged.import(entry)));
      modules.set(ref, { settings, conversations, workspace, goals, automations }); report.tags.push(tagged.evidence());
    }
    const old = modules.get('v0.0.18');
    function fixture(name) {
      const home = path.join(root, 'data', name), folder = path.join(home, 'workspace'); mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'README.md'), 'unchanged legacy project\n');
      const settings = old.settings.createSettingsStore({ settingsFile: path.join(home, 'settings.json') });
      settings.merge({ appearance: 'dark', locale: 'zh-CN', appMode: 'work', workspaces: [{ path: folder, name: 'Legacy project', addedAt: '2026-09-01T00:00:00.000Z' }], activeWorkspace: folder,
        remoteAccess: { enabled: false, workspaceId: 'legacy-remote', mode: 'read_only' }, memory: { enabled: true } });
      const conversations = old.conversations.createConversationStore({ storeDir: path.join(home, 'conversations') });
      const classic = conversations.createConversation({ title: 'Legacy conversation', workspacePath: folder, mode: 'work' });
      conversations.appendMessage(classic.id, { id: 'legacy-message', role: 'user', content: 'Preserve this legacy message', createdAt: '2026-09-01T00:00:00.000Z' });
      const goal = old.goals.createGoalPlanStore({ storeDir: path.join(home, 'plans') }).createPlan({ title: 'Legacy goal', goal: 'Preserve goal', conversationId: classic.id });
      const automation = old.automations.createAutomationStore({ storeDir: path.join(home, 'automations') }).createDefinition({ name: 'Legacy automation', prompt: 'Preserve automation', workspacePath: folder,
        schedule: { kind: 'weekdays', timezone: 'Asia/Shanghai', hour: 9, minute: 0 }, status: 'active', missedRunPolicy: 'run_latest', overlapPolicy: 'skip',
        grant: { preset: 'observe', workspacePath: folder, allowedCapabilityIds: [], askCapabilityIds: [], blockedCapabilityIds: [], confirmedAt: '2026-09-01T00:00:00.000Z', version: 1 } });
      const immutable = { ...Object.fromEntries(Object.entries(tree(home)).filter(([file]) => !file.startsWith('settings.json'))) };
      const catalogs = Object.fromEntries(['conversations/index.jsonl','plans/index.jsonl','plans/.changes.jsonl'].map(file => [file, readFileSync(path.join(home, file), 'utf8')]));
      return { home, folder, settingsFile: path.join(home, 'settings.json'), classic, goal, automation, immutable, catalogs };
    }
    const upgrade = (f, ref) => modules.get(ref).settings.createSettingsStore({ settingsFile: f.settingsFile }).getAll();
    function preserved(f, appended = false) {
      const shared = ['conversations/.changes.json', ...Object.keys(f.catalogs)];
      verifyFiles(f.home, appended ? Object.fromEntries(Object.entries(f.immutable).filter(([file]) => !shared.includes(file))) : f.immutable);
      if (appended) for (const [file, original] of Object.entries(f.catalogs)) assert.ok(readFileSync(path.join(f.home, file), 'utf8').startsWith(original), `legacy catalog prefix retained ${file}`);
      const conversations = createConversationStore({ storeDir: path.join(f.home, 'conversations') });
      assert.equal(conversations.getPersistedConversationHistory(f.classic.id).messages[0].content, 'Preserve this legacy message');
      assert.equal(createGoalPlanStore({ storeDir: path.join(f.home, 'plans') }).getPlan(f.goal.planId).title, 'Legacy goal');
      assert.equal(createAutomationStore({ storeDir: path.join(f.home, 'automations') }).getDefinition(f.automation.automationId).name, 'Legacy automation');
    }
    for (const ref of betas) await check(`0.0.18 -> ${ref}`, () => {
      const f = fixture(ref), original = readFileSync(f.settingsFile);
      const settings = upgrade(f, ref); assert.ok(settings.schemaVersion >= 2); assert.match(settings.workspaces[0].id, /^[0-9a-f-]{36}$/);
      assert.equal(settings.remoteAccess.workspaceId, settings.workspaces[0].id);
      const registry = createProjectRegistry({ filePath: path.join(f.home, 'projects/registry.json') });
      assert.equal(registry.get(settings.workspaces[0].id).remoteAlias, 'legacy-remote');
      const backups = readdirSync(f.home).filter(file => file.startsWith('settings.json.bak-v'));
      assert.ok(backups.some(file => digest(readFileSync(path.join(f.home, file))) === digest(original)));
      const before = tree(f.home); upgrade(f, ref); assert.deepEqual(tree(f.home), before, 'idempotent repeated migration'); preserved(f);
      return { schemaVersion: settings.schemaVersion, legacyFiles: Object.keys(f.immutable).length, backupExact: true };
    });
    const consecutive = fixture('consecutive'); let identity;
    for (let i = 0; i < betas.length; i++) await check(`${i ? betas[i-1] : '0.0.18'} -> ${betas[i]}; restart`, async () => {
      const settings = upgrade(consecutive, betas[i]); identity ??= settings.workspaces[0].id; assert.equal(settings.workspaces[0].id, identity); preserved(consecutive);
      if (i && includeRecovery) {
        const f = fixture(`recovery-${i}`); const previous = upgrade(f, betas[i-1]);
        const store = createConversationStore({ storeDir: path.join(f.home, 'conversations') });
        const parent = store.createConversation({ role: 'project_agent', workspaceId: previous.workspaces[0].id, workspacePath: f.folder });
        writeFileSync(path.join(f.home, 'fixture.json'), JSON.stringify({ workspaceId: previous.workspaces[0].id, workspacePath: f.folder, conversationId: parent.id }));
        createInputQueue({ rootDir: path.join(f.home, 'project-runtime') }).submitInput({ workspaceId: previous.workspaces[0].id, inputId: 'input-one', surface: 'desktop', text: 'Read the project once' });
        assert.equal((await recovery(f.home, 'task_created')).killed, true);
        assert.equal(upgrade(f, betas[i]).workspaces[0].id, previous.workspaces[0].id);
        await new Promise(resolve => setTimeout(resolve, 1100));
        const restored = await recovery(f.home); assert.deepEqual(restored.counts, { inputs: 1, replies: 1, tasks: 2 }); assert.equal(restored.workerCalls, 1);
        const again = await recovery(f.home); assert.deepEqual(again.counts, restored.counts); assert.equal(again.workerCalls, 0, 'waiting_user must not silently resume'); preserved(f, true);
      }
      return { stableIdentity: true, realCrashRecovery: Boolean(i && includeRecovery) };
    });
    await check('beta.5 -> 0.0.18 reader/write -> RC re-upgrade preserves all new data', () => {
      const f = fixture('downgrade'); const settings = upgrade(f, betas.at(-1)), workspaceId = settings.workspaces[0].id;
      const conversations = createConversationStore({ storeDir: path.join(f.home, 'conversations') });
      const agent = conversations.createConversation({ role: 'project_agent', workspaceId, workspacePath: f.folder, title: 'New bot' });
      const task = conversations.createConversation({ role: 'work_session', workspaceId, workspacePath: f.folder, parentConversationId: agent.id, title: 'New task' });
      for (const row of [agent, task]) conversations.appendMessage(row.id, { id: `${row.id}-message`, role: 'user', content: 'new message' });
      assert.equal(createBotProfileStore({ rootDir: f.home }).create({ workspaceId, displayName: 'Unique bot', agentConversationId: agent.id }).ok, true);
      assert.equal(createMemoryStore({ rootDir: f.home }).rememberStated({ workspaceId, kind: 'fact', text: '登录页在 src/login.tsx', anchorMessageId: 'm-user', messages: [{ id: 'm-user', role: 'user', kind: 'user_input', content: '记住：登录页在 src/login.tsx' }] }).ok, true);
      assert.equal(createObjectiveStore({ rootDir: f.home }).create({ workspaceId, projectAgentConversationId: agent.id, originMessageId: 'm-user', title: 'Keep project healthy', outcome: 'No regressions', autonomy: 'propose', createdBy: 'user_request', successSignals: [], milestones: [], watches: [] }).ok, true);
      const protectedFiles = Object.fromEntries(Object.entries(tree(f.home)).filter(([file]) => !file.startsWith('settings.json')));
      const oldStore = old.settings.createSettingsStore({ settingsFile: f.settingsFile });
      const oldWorkspace = old.workspace.createWorkspaceApplicationService({ getSettings: () => oldStore.getAll(), mergeSettings: patch => oldStore.merge(patch), pathExists: existsSync,
        basename: path.basename, getDefaultWorkspacePath: () => f.folder, ensureDirectory: dir => mkdirSync(dir, { recursive: true }), chooseDirectory: async () => null,
        setChatWorkspacePath() {}, readProjectIndex: () => null });
      const oldList = oldWorkspace.listWorkspaces(); assert.equal(oldList.workspaces[0].path, f.folder);
      oldStore.merge({ workspaces: oldList.workspaces }); assert.equal(oldStore.getAll().workspaces[0].id, undefined);
      const oldConversations = old.conversations.createConversationStore({ storeDir: path.join(f.home, 'conversations') });
      for (const row of [f.classic, agent, task]) assert.ok(oldConversations.getPersistedConversationHistory(row.id).messages.length > 0);
      verifyFiles(f.home, protectedFiles);
      assert.equal(loadMigratedSettings(f.settingsFile).workspaces[0].id, workspaceId); verifyFiles(f.home, protectedFiles); preserved(f, true);
      return { classicAndNewConversationsReadable: 3, protectedFiles: Object.keys(protectedFiles).length };
    });
    await check('migration backup failure keeps original settings and legacy data', () => {
      const f = fixture('backup-failure'), original = readFileSync(f.settingsFile), now = () => new Date('2026-10-01T00:00:00.000Z');
      mkdirSync(path.join(f.home, 'settings.json.bak-v0-2026-10-01T00-00-00.000Z'));
      const result = loadMigratedSettings(f.settingsFile, { now, log() {} }); assert.equal(result.schemaVersion, undefined);
      assert.deepEqual(readFileSync(f.settingsFile), original); preserved(f);
    });
    for (const version of updaterVersions) await check(`${version} auto -> GA stable updater graduation`, async () => {
      const before = tree(consecutive.home), value = await updater(version);
      assert.equal(value.status.channel, 'stable'); assert.equal(value.status.phase, 'available'); assert.equal(value.status.availableVersion, '0.1.0');
      assert.deepEqual(value.calls, ['latest']); assert.equal(value.autoDownload, false); assert.deepEqual(tree(consecutive.home), before);
    });
    await check('explicit beta stays beta; older stable feed falls back without download', async () => {
      assert.equal((await updater('0.1.0-beta.5', 'beta')).status.channel, 'beta');
      const fallback = await updater('0.1.0-beta.5', 'auto', '0.0.18'); assert.equal(fallback.status.channel, 'beta');
      assert.deepEqual(fallback.calls, ['latest','beta']); assert.equal(fallback.autoDownload, false);
    });
  } catch (error) { report.setupError = String(error.message).split(root).join('<fixture>'); }
  finally {
    report.ok = !report.setupError && report.checks.length === 13 + updaterVersions.length && report.checks.every(row => row.ok) && includeRecovery;
    report.finishedAt = new Date().toISOString(); rmSync(root, { recursive: true, force: true }); report.fixtureRemoved = true;
    if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  }
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const index = process.argv.indexOf('--output'); const report = await runUpgradeMatrix({ output: index < 0 ? null : process.argv[index + 1] });
  console.log(JSON.stringify({ ok: report.ok, sourceHead: report.sourceHead, sourceDirty: report.sourceDirty, setupError: report.setupError, checks: report.checks }, null, 2));
  if (!report.ok) process.exitCode = 1;
}
