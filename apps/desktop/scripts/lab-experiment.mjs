#!/usr/bin/env node
// 自控实验台：让实验版本、实验室启停、提示词发送与授权应答都由我这一侧执行。
//
// 为什么需要它：受控隔离实验此前依赖人工发送与人工重启，且「跑的是哪份代码」说不清。
// 本脚本把三件事收回来：
//   1. version —— 记录实验版本指纹（HEAD + 未提交改动 + 实际构建产物），同一份代码给出同一指纹。
//   2. run     —— 自己拉起一个隔离实验实例（独立 PEER_AGENT_HOME / user-data-dir），
//                 自己新建会话、发送提示词、响应授权弹窗，最后采集磁盘证据并写报告。
//
// 隔离边界：绝不触碰宿主实例（打包 App）与用户正在看的 dev 实例。
// 源码与产物另有一层隔离：run/probe 先复制到 labHome/isolated-workspace，
// Electron 从那里启动，会话 activeWorkspace 绑隔离后的 apps/desktop，不绑整仓根。
// 每次 run 都新开进程、用完即关，PEER_AGENT_HOME 默认 ~/.peer-agent-lab。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createOwnedProcessRegistry } from './lab-process-identity.mjs';
import { injectIsolatedTitleCrop, prepareLabIsolation } from './lab-workspace-isolate.mjs';

export function permissionFingerprint(kind, text) {
  return `${kind}:${String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 160)}`;
}

export function shouldClickVisibleControl({ fingerprint, lastFingerprint, enabled = true } = {}) {
  if (!enabled) return false;
  if (!fingerprint) return false;
  return fingerprint !== lastFingerprint;
}

// 报告 closed 只认句柄真正退出。stop() 发过信号不等于进程已死（38.17）。
export function markLabReportClosed(stopResult) {
  return stopResult?.exited === true;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');

const DEFAULT_LAB_HOME = path.join(os.homedir(), '.peer-agent-lab');
const REPORT_DIR = path.join(DEFAULT_LAB_HOME, 'experiments');

// 指纹覆盖面：渲染层产物 + 主进程代码 + 运行时常量。三者决定实验实例实际执行的代码。
const FINGERPRINT_PATHS = [
  'apps/desktop/dist',
  'apps/desktop/electron/main',
  'packages/runtime-node/dist',
];

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

// 内容指纹：同一份产物必须给出同一结果，所以只用相对路径 + 内容，不用 mtime。
function hashTree(absoluteRoot) {
  const files = walkFiles(absoluteRoot);
  const parts = [];
  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    let content;
    try {
      content = fs.readFileSync(file);
    } catch {
      continue;
    }
    parts.push(`${relative}\u0000${sha256(content)}`);
  }
  return { hash: sha256(parts.join('\n')), fileCount: parts.length };
}

export function experimentFingerprint() {
  const head = git(['rev-parse', 'HEAD']);
  const headShort = git(['rev-parse', '--short', 'HEAD']);

  // 未提交改动：工作区相对 HEAD 的实际差异（含已跟踪改动），加上未跟踪文件清单。
  let trackedDiff = '';
  try {
    trackedDiff = execFileSync('git', ['diff', 'HEAD', '--binary'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    trackedDiff = '';
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .sort()
    .join('\n');
  const worktreeHash = sha256(`${trackedDiff}\n--untracked--\n${untracked}`);

  let trees = {};
  for (const relativePath of FINGERPRINT_PATHS) {
    trees[relativePath] = hashTree(path.join(REPO_ROOT, relativePath));
  }

  const buildHash = sha256(
    Object.entries(trees)
      .map(([key, value]) => `${key}:${value.hash}`)
      .join('\n'),
  );
  const buildPresent = Object.values(trees).every((value) => value.fileCount > 0);

  return {
    // experimentVersion 是给人看与写进报告的稳定标识。
    experimentVersion: `${headShort}+w${worktreeHash.slice(0, 8)}+b${buildHash.slice(0, 8)}`,
    head,
    headShort,
    worktreeHash,
    buildHash,
    buildPresent,
    treeFileCounts: Object.fromEntries(
      Object.entries(trees).map(([key, value]) => [key, value.fileCount]),
    ),
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 实验实例
// ---------------------------------------------------------------------------
// 默认跑渲染层构建产物（apps/desktop/dist），而不是 vite dev：
//   1. 确定性更高——同一份构建产物对应同一实验版本；
//   2. 不与用户正在看的 dev 实例（5273）抢端口或抢窗口；
//   3. 隔离靠独立 PEER_AGENT_HOME + 独立 --user-data-dir，进程用完即关。

const MAIN_WINDOW_URL_HINTS = ['/dist/index.html'];

function readLabSettings(labHome) {
  const file = path.join(labHome, 'settings.json');
  const providersFile = path.join(labHome, 'llm-providers.json');
  const result = { file, exists: fs.existsSync(file), localAccessLevel: null, channelCount: null };
  if (!result.exists) return result;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    result.localAccessLevel = parsed.localAccessLevel ?? null;
  } catch (error) {
    result.parseError = String(error?.message ?? error);
  }
  // 模型通道不在 settings.json，而在 llm-providers.json。
  try {
    const providers = JSON.parse(fs.readFileSync(providersFile, 'utf8'));
    const list = Array.isArray(providers) ? providers : (providers.providers ?? providers.channels ?? []);
    result.channelCount = Array.isArray(list) ? list.length : null;
  } catch {
    result.channelCount = null;
  }
  return result;
}

async function waitForMainWindow(app, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const candidate of app.windows()) {
      const url = candidate.url();
      const isMain = MAIN_WINDOW_URL_HINTS.some((hint) => url.includes(hint))
        && !url.includes('window=');
      if (isMain) return candidate;
    }
    await sleep(150);
  }
  const seen = app.windows().map((window) => window.url()).join(', ') || '(none)';
  throw new Error(`主窗口未就绪，已见窗口: ${seen}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 新建会话：优先点侧栏「新任务」。冷启动时主窗口先出来、侧栏后出现（17-53-33 报
// `button.sidebar-new-chat` 10s 超时），所以先等输入框，再等侧栏；侧栏始终不出现
// 时，只要 composer 可用就直接发，不把冷启动当实验失败。
async function startNewConversation(page) {
  const composer = page.locator('form.chat-composer textarea').first();
  const newChat = page.locator('button.sidebar-new-chat').last();
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await newChat.isVisible().catch(() => false)) {
      await newChat.click();
      await composer.waitFor({ state: 'visible', timeout: 15000 });
      return 'sidebar-new-chat';
    }
    if (await composer.isVisible().catch(() => false)) {
      return 'composer-ready';
    }
    await sleep(250);
  }
  throw new Error('startNewConversation: composer and sidebar-new-chat stayed hidden for 45s');
}

// 发送提示词。
//
// 第一次失败（attempt 2）就死在这里：编辑器里残留了上一轮的草稿，`fill` 之后按回车
// 变成了「发送了一段被拼接过的文本」，界面上看起来发了、实际没进入本轮回合。
// 所以这里先清空并**核对确实为空**，发送后再核对回合真的开始了（出现了用户消息气泡），
// 而不是假设回车一定生效。
async function sendPrompt(page, prompt, labHome) {
  const textarea = page.locator('form.chat-composer textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 10000 });
  if (await textarea.isDisabled()) {
    throw new Error('输入框被禁用（通常是该实例没有可用模型通道）');
  }
  await textarea.click();

  // 清空残留草稿，并确认清空了再写；否则会发出拼接过的内容。
  await textarea.fill('');
  const afterClear = await textarea.inputValue();
  if (afterClear.trim() !== '') {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
  }
  const clearedValue = await textarea.inputValue();
  if (clearedValue.trim() !== '') {
    throw new Error(`输入框无法清空（残留 ${clearedValue.length} 字符），不发送以免发出拼接文本`);
  }

  const before = snapshotConversationSizes(labHome);
  await textarea.fill(prompt);

  // 用「先聚焦、再由页面级键盘发送」，不要用 elementHandle.press('Enter')。
  // 后者要求元素在发送瞬间保持 attached + visible + stable + 可接收事件；
  // 输入框在 React 受控更新/布局动画期间会短暂不满足，于是报
  // `locator.press: Timeout 10000ms exceeded`——文本明明已经在框里，却按不下去。
  // 这正是 attempt 2 与 attempt 3 共同的失败点。
  await textarea.focus();
  await page.keyboard.press('Enter');

  // 「回合真的开始了」以磁盘事实为准（会话文件增长），而不是猜 DOM 类名：
  // 之前那套气泡选择器在仓库里根本不存在，会把成功的发送判成失败。
  // 输入框被清空作为快速信号，磁盘增长作为权威信号。
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (conversationGrew(before, labHome)) return 'composer-enter';
    const value = await textarea.inputValue().catch(() => 'x');
    if (value.trim() === '') return 'composer-enter';
    await sleep(400);
  }
  throw new Error('提示词已输入但未见回合开始（会话文件未增长，输入框也未清空）');
}

// 会话文件大小快照：发送前拍一张，发送后看是否增长。index.jsonl 只是目录，不算。
export function snapshotConversationSizes(labHome) {
  const dir = path.join(labHome, 'conversations');
  const snapshot = new Map();
  if (!fs.existsSync(dir)) return snapshot;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl') || name === 'index.jsonl') continue;
    try {
      snapshot.set(name, fs.statSync(path.join(dir, name)).size);
    } catch {
      // 文件在快照期间被替换，忽略即可。
    }
  }
  return snapshot;
}

export function conversationGrew(before, labHome) {
  const after = snapshotConversationSizes(labHome);
  for (const [name, size] of after) {
    if (!before.has(name)) return true;
    if (size > (before.get(name) ?? 0)) return true;
  }
  return false;
}

// 本轮的「主计划」摘要：取本轮新建、任务数最多的那份计划。
// 用来判断契约是否仍停在 intake（需要用户确认），而不是靠猜界面上有没有按钮。
function summarizeRunPlan(labHome, sinceMs) {
  const dir = path.join(labHome, 'goal-plans');
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs < sinceMs) continue;
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (!plan?.planId) continue;
    const taskCount = Array.isArray(plan.tasks) ? plan.tasks.length : 0;
    if (!best || taskCount > best.taskCount || (taskCount === best.taskCount && stat.mtimeMs > best.mtimeMs)) {
      best = {
        planId: plan.planId,
        title: plan.title ?? null,
        status: plan.status ?? null,
        activation: plan.activation?.kind ?? null,
        taskCount,
        hasRunner: Boolean(plan.runner),
        runnerStatus: plan.runner?.status ?? null,
        progress: plan.progress ?? null,
        taskCount2: taskCount,
        mtimeMs: stat.mtimeMs,
        file: name,
      };
    }
  }
  if (!best) return null;
  delete best.taskCount2;
  return best;
}

// 驱动「批准计划 / 应答授权」，并在「持续安静」后判定结束——两者必须是**同一个循环**。
//
// 为什么不能分成两步（先应答、再等收敛）：修复类任务里，授权弹窗（打开受治理预览、跑命令重建）
// 是在回合进行到中段才出现的。若应答循环先退出，后面的弹窗就没人应答，任务会一直挂着等人。
//
// 三个真实原因逼出这个循环：
//   1. 计划可能停在 intake（模型只在正文里说"确认后再动手"，没调 goal_create_plan），
//      需要用户回一句确认——这一步在调用方按磁盘状态决定。
//   2. 一次任务里授权不止一次。
//   3. 多步任务回合之间有空隙，必须「持续安静」才算收敛，否则会提前关窗口打断任务。
async function driveUntilIdle(page, decision, options = {}) {
  const quietMs = options.quietMs ?? 90000;
  const maxMs = options.maxMs ?? 1800000;
  const events = [];
  const startedAt = Date.now();
  let quietSince = null;
  let lastPermissionFingerprint = null;
  let lastPlanFingerprint = null;

  while (Date.now() - startedAt < maxMs) {
    let acted = false;

    const strip = page.locator('.permission-gate-strip').first();
    if (await strip.isVisible().catch(() => false)) {
      const label = await strip.innerText().catch(() => '');
      const buttonSelector = decision === 'allow' ? 'button.allow' : 'button.deny';
      const button = strip.locator(buttonSelector).first();
      const text = label.trim().replace(/\s+/g, ' ').slice(0, 160);
      const fingerprint = permissionFingerprint('permission', `${buttonSelector}:${text}`);
      if (
        await button.isVisible().catch(() => false)
        && shouldClickVisibleControl({
          fingerprint,
          lastFingerprint: lastPermissionFingerprint,
          enabled: await button.isEnabled().catch(() => false),
        })
      ) {
        await button.click({ timeout: 5000 }).catch(() => {});
        lastPermissionFingerprint = fingerprint;
        events.push({
          kind: 'permission',
          decision,
          button: buttonSelector,
          text,
        });
        acted = true;
      }
    }

    // Plan 审批流的按钮类名是 .goal-plan-action--start（NEXT_ACTIONS = start/adjust/cancel）。
    const startButton = page.locator('.goal-plan-action--start').first();
    if (await startButton.isVisible().catch(() => false)) {
      const text = (await startButton.innerText().catch(() => '')).trim().slice(0, 60);
      const fingerprint = permissionFingerprint('plan-approval', text);
      const enabled = await startButton.isEnabled().catch(() => false);
      if (shouldClickVisibleControl({
        fingerprint,
        lastFingerprint: lastPlanFingerprint,
        enabled,
      })) {
        await startButton.click({ timeout: 5000 }).catch(() => {});
        lastPlanFingerprint = fingerprint;
        events.push({ kind: 'plan-approval', action: 'start', text });
        acted = true;
      } else if (!enabled) {
        // 流式输出中按钮是 disabled 的，仍视作「有事在进行」。
        quietSince = null;
        await sleep(1000);
        continue;
      }
    }

    const busy = await page
      .locator('button[aria-label*="停止"], .stop-button, [data-streaming="true"]')
      .count()
      .catch(() => 0);

    if (acted || busy > 0) {
      quietSince = null;
    } else {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return { events, settled: true };
    }
    await sleep(1000);
  }
  return { events, settled: false };
}

function newestFiles(directory, pattern, limit) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => {
      const full = path.join(directory, name);
      const stat = fs.statSync(full);
      return { name, full, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 采集磁盘证据：这是「实验是否真的发生了」的权威依据，而不是界面看起来如何。
function collectDiskEvidence(labHome, sinceMs) {
  const conversations = newestFiles(path.join(labHome, 'conversations'), /\.jsonl$/, 5);
  const plans = newestFiles(path.join(labHome, 'goal-plans'), /\.json$/, 5);
  const artifacts = newestFiles(path.join(labHome, 'ui-delivery', 'artifacts'), /\.json$/, 5);

  const during = (entry) => entry.mtimeMs >= sinceMs;
  const planDigests = plans.filter(during).map((entry) => {
    const parsed = readJsonSafe(entry.full);
    return {
      file: path.relative(labHome, entry.full),
      mtime: new Date(entry.mtimeMs).toISOString(),
      planId: parsed?.planId ?? null,
      status: parsed?.status ?? null,
      activation: parsed?.activation?.kind ?? null,
      progress: parsed?.progress ?? null,
      runner: parsed?.runner
        ? {
          status: parsed.runner.status ?? null,
          blockedReason: parsed.runner.blockedReason ?? null,
        }
        : null,
    };
  });

  return {
    conversationsTouched: conversations
      .filter(during)
      .map((entry) => ({ file: path.basename(entry.full), mtime: new Date(entry.mtimeMs).toISOString(), size: entry.size })),
    plansTouched: planDigests,
    uiDeliveryArtifactsTouched: artifacts
      .filter(during)
      .map((entry) => ({ file: path.basename(entry.full), mtime: new Date(entry.mtimeMs).toISOString() })),
  };
}

// ---------------------------------------------------------------------------
// 实例互斥与收尾
// ---------------------------------------------------------------------------
// 第二次失败（attempt 2）的原因：紧接上一次失败又起了一个实例，而上一个实例的
// `--user-data-dir` 还没释放，新实例启动后没人清扫，于是「还没发出去就断了」。
// 这里把「同一 user-data-dir 同时只能有一个实验实例」变成脚本的前置条件，
// 而不是靠我下一次记得等。

// 只观察「这个 user-data-dir 是否仍被占用」，用来等待互斥槽位。
// 观察结果绝不能拿去 kill：停止只走 ownedProcesses 里本轮登记的句柄。
function findLiveExperimentInstances(userDataDir) {
  try {
    const output = execFileSync('pgrep', ['-fl', userDataDir], { encoding: 'utf8' });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      // 脚本自身命令行里也含这个路径，不能把自己当成占用者。
      .filter((line) => !line.includes('lab-experiment.mjs'));
  } catch {
    // pgrep 无匹配时退出码为 1，这不是错误。
    return [];
  }
}

async function acquireInstanceSlot(userDataDir, timeoutMs) {
  const startedAt = Date.now();
  let lastSeen = [];
  while (Date.now() - startedAt < timeoutMs) {
    lastSeen = findLiveExperimentInstances(userDataDir);
    if (lastSeen.length === 0) {
      return { ok: true, waitedMs: Date.now() - startedAt };
    }
    await sleep(1000);
  }
  return { ok: false, waitedMs: Date.now() - startedAt, live: lastSeen };
}

// 本轮自己拉起的 Playwright Electron 句柄。停止只走这个登记表，
// 不用 pgrep / 父 PID 推断去发信号（见 lab-process-identity.mjs）。
const ownedProcesses = createOwnedProcessRegistry();

function trackApp(app) {
  const processHandle = typeof app.process === 'function' ? app.process() : null;
  return ownedProcesses.register({
    process: processHandle,
    pid: processHandle?.pid ?? null,
    async close() {
      await app.close().catch(() => processHandle?.kill('SIGKILL'));
    },
  });
}

function untrackApp(handleId) {
  if (typeof handleId === 'string') ownedProcesses.release(handleId);
}

async function closeTrackedApps(reason = 'owned') {
  await ownedProcesses.closeAll(reason);
}

let signalCleanupInstalled = false;

function installSignalCleanup() {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      process.stderr.write(`\n收到 ${signal}，正在关闭本轮实验实例…\n`);
      closeTrackedApps('cancel').finally(() => process.exit(130));
    });
  }
}

async function runExperiment(options) {
  const labHome = options.labHome;
  const startedAt = Date.now();
  const fingerprint = experimentFingerprint();
  const isolation = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  const desktopDir = isolation.launch.desktopDir;
  const settings = readLabSettings(labHome);

  if (!fs.existsSync(path.join(DESKTOP_DIR, 'dist', 'index.html'))) {
    throw new Error('渲染层产物缺失：先跑 pnpm --filter @peer-agent/desktop build（或用 --build）');
  }
  seedIsolatedRendererDist(isolation.isolated.distDir);
  const titleCrop = options.injectTitleCrop
    ? injectIsolatedTitleCrop(isolation.isolated)
    : null;

  const { _electron: electron } = await import('playwright-core');
  const env = {
    ...process.env,
    PEER_AGENT_HOME: labHome,
    NODE_PATH: [
      path.join(isolation.launch.workspaceRoot, 'node_modules'),
      path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules'),
      path.join(REPO_ROOT, 'node_modules'),
    ].join(path.delimiter),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.DISPLAY && process.platform === 'linux') env.DISPLAY = ':1';

  // 用独立的 user-data-dir：Electron 的单例锁是「按 user-data-dir」的，
  // 直接复用 electron-user-data 会和用户正在看的 lab 实例抢锁、把对方顶掉。
  // PEER_AGENT_HOME 仍指向 lab home，所以模型通道/凭据/证据目录与 lab 一致。
  const userDataDir = path.join(labHome, 'electron-user-data-experiment');

  const report = {
    kind: 'lab-experiment',
    fingerprint,
    labHome,
    userDataDir,
    settings,
    isolation: isolation.evidence,
    titleCrop,
    prompt: options.prompt,
    requestedDecision: options.decision,
    startedAt: new Date(startedAt).toISOString(),
    steps: {},
    error: null,
  };

  let app;
  let ownedHandleId = null;
  try {
    installSignalCleanup();
    const slot = await acquireInstanceSlot(userDataDir, options.instanceWaitMs);
    report.instanceSlot = { ok: slot.ok, waitedMs: slot.waitedMs };
    if (!slot.ok) {
      throw new Error(
        `实验实例互斥等待超时（${slot.waitedMs}ms）：仍有实例占用 ${userDataDir}，`
        + `先让它退出再重试。占用者：${(slot.live ?? []).join(' | ')}`,
      );
    }
    app = await electron.launch({
      args: [desktopDir, `--user-data-dir=${userDataDir}`],
      cwd: isolation.launch.desktopDir,
      env,
      timeout: 15000,
    });
    ownedHandleId = trackApp(app);
    report.steps.launched = true;

    const page = await waitForMainWindow(app, 20000);
    page.setDefaultTimeout(10000);
    report.steps.mainWindowUrl = page.url();

    report.steps.newConversation = await startNewConversation(page);
    report.steps.sent = await sendPrompt(page, options.prompt, labHome);

    const driven = await driveUntilIdle(page, options.decision, {
      quietMs: options.settleQuietMs,
      maxMs: options.approvalMaxMs,
    });
    report.steps.approvals = driven.events;
    report.steps.turnSettled = driven.settled;

    // 计划可能停在 intake：模型在正文里把方案说清楚、却没有调用 goal_create_plan，
    // 于是契约不会被就地升级成 accepted_goal，runner 保持 null，什么都不推进。
    // 真实用户这时会回一句确认，所以实验台也照做——但**是否还需要确认按磁盘状态决定**，
    // 不是无条件多发一条。
    report.steps.confirmRounds = [];
    for (let round = 0; round < options.maxConfirmRounds; round += 1) {
      const plan = summarizeRunPlan(labHome, startedAt);
      if (!plan || plan.activation !== 'intake' || plan.hasRunner) break;

      const confirmText = options.confirmText;
      await sendPrompt(page, confirmText, labHome).catch((error) => {
        report.steps.confirmRounds.push({ round, confirmText, error: String(error?.message ?? error) });
        return null;
      });
      const after = await driveUntilIdle(page, options.decision, {
        quietMs: options.settleQuietMs,
        maxMs: options.approvalMaxMs,
      });
      report.steps.confirmRounds.push({
        round,
        confirmText,
        approvals: after.events,
        turnSettled: after.settled,
        planAfter: summarizeRunPlan(labHome, startedAt),
      });
      if (!after.settled) break;
    }

    report.steps.finalPlan = summarizeRunPlan(labHome, startedAt);

    if (options.screenshot) {
      const shot = path.join(REPORT_DIR, `shot-${fingerprint.experimentVersion}-${Date.now()}.png`);
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      report.screenshot = shot;
    }

    report.steps.transcript = await page
      .locator('body')
      .innerText()
      .then((text) => text.slice(-4000))
      .catch(() => null);
  } catch (error) {
    report.error = String(error?.stack ?? error?.message ?? error);
  } finally {
    if (ownedHandleId && !options.keepOpen) {
      const stopResult = await ownedProcesses.stop({ handleId: ownedHandleId, reason: 'owned' });
      report.closed = markLabReportClosed(stopResult);
      report.stop = {
        ok: stopResult?.ok === true,
        code: stopResult?.code ?? null,
        signaled: stopResult?.signaled === true,
        exited: stopResult?.exited === true,
      };
      if (report.closed) untrackApp(ownedHandleId);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.disk = collectDiskEvidence(labHome, startedAt);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  report.reportPath = path.join(
    REPORT_DIR,
    `${new Date(startedAt).toISOString().replaceAll(':', '-')}-${fingerprint.experimentVersion}.json`,
  );
  fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// 只验证「我能自己把隔离实例拉起来再关掉」，不消耗模型调用。
async function probeLab(options) {
  const labHome = options.labHome;
  const fingerprint = experimentFingerprint();
  const isolation = prepareLabIsolation({ sourceRoot: REPO_ROOT, labHome });
  const desktopDir = isolation.launch.desktopDir;
  const settings = readLabSettings(labHome);
  const userDataDir = path.join(labHome, 'electron-user-data-experiment');
  seedIsolatedRendererDist(isolation.isolated.distDir);

  const { _electron: electron } = await import('playwright-core');
  const env = {
    ...process.env,
    PEER_AGENT_HOME: labHome,
    NODE_PATH: [
      path.join(isolation.launch.workspaceRoot, 'node_modules'),
      path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules'),
      path.join(REPO_ROOT, 'node_modules'),
    ].join(path.delimiter),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.DISPLAY && process.platform === 'linux') env.DISPLAY = ':1';

  const report = {
    kind: 'lab-probe',
    fingerprint,
    labHome,
    userDataDir,
    settings,
    isolation: isolation.evidence,
    error: null,
  };

  let app;
  let ownedHandleId = null;
  try {
    installSignalCleanup();
    const slot = await acquireInstanceSlot(userDataDir, options.instanceWaitMs);
    report.instanceSlot = { ok: slot.ok, waitedMs: slot.waitedMs };
    if (!slot.ok) {
      throw new Error(
        `实验实例互斥等待超时（${slot.waitedMs}ms）：仍有实例占用 ${userDataDir}`,
      );
    }
    const startedAt = Date.now();
    app = await electron.launch({
      args: [desktopDir, `--user-data-dir=${userDataDir}`],
      cwd: isolation.launch.desktopDir,
      env,
      timeout: 15000,
    });
    ownedHandleId = trackApp(app);
    report.launchMs = Date.now() - startedAt;
    const page = await waitForMainWindow(app, 20000);
    report.mainWindowUrl = page.url();
    report.title = await page.title().catch(() => null);
    page.setDefaultTimeout(10000);

    // 主窗口加载完 ≠ React 水合完。等外壳出现，否则截图会是一张空壳。
    const shellDeadline = Date.now() + 30000;
    let shellReady = false;
    while (Date.now() < shellDeadline) {
      if ((await page.locator('button.sidebar-new-chat').count()) > 0) {
        shellReady = true;
        break;
      }
      await sleep(500);
    }
    report.shellReady = shellReady;
    report.shellWaitMs = Date.now() - (startedAt + report.launchMs);
    if (!shellReady) {
      report.windowErrors = app.windows().map((window) => window.url());
    }

    if (options.screenshot) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const shot = path.join(REPORT_DIR, `probe-${fingerprint.experimentVersion}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      report.screenshot = shot;
    }
    report.bodyHead = await page
      .locator('body')
      .innerText()
      .then((text) => text.slice(0, 500))
      .catch(() => null);
    report.composerPresent = (await page.locator('form.chat-composer textarea').count()) > 0;
  } catch (error) {
    report.error = String(error?.stack ?? error?.message ?? error);
  } finally {
    if (ownedHandleId && !options.keepOpen) {
      const stopResult = await ownedProcesses.stop({ handleId: ownedHandleId, reason: 'owned' });
      report.closed = markLabReportClosed(stopResult);
      report.stop = {
        ok: stopResult?.ok === true,
        code: stopResult?.code ?? null,
        signaled: stopResult?.signaled === true,
        exited: stopResult?.exited === true,
      };
      if (report.closed) untrackApp(ownedHandleId);
    }
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  report.reportPath = path.join(REPORT_DIR, `probe-${Date.now()}-${fingerprint.experimentVersion}.json`);
  fs.writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function seedIsolatedRendererDist(distDir) {
  const sourceDist = path.join(DESKTOP_DIR, 'dist');
  if (!fs.existsSync(path.join(sourceDist, 'index.html'))) {
    throw new Error('渲染层产物缺失：先跑 pnpm --filter @peer-agent/desktop build（或用 --build）');
  }
  fs.cpSync(sourceDist, distDir, { recursive: true });
}

function parseArgs(argv) {
  const options = {
    command: argv[0] ?? 'version',
    prompt: null,
    decision: 'deny',
    labHome: process.env.PEER_LAB_HOME ?? DEFAULT_LAB_HOME,
    approvalMaxMs: 1800000,
    // 「持续安静」多久才算收敛。修复链路里回合间隙可能较长，所以放得保守。
    settleQuietMs: 90000,
    // 计划停在 intake 时，最多补几轮「用户确认」（按磁盘状态决定是否需要）。
    maxConfirmRounds: 2,
    confirmText: '可以，请开始执行。',
    // 同一 user-data-dir 上若还有实例未退出，最多等这么久（1 秒轮询）。
    instanceWaitMs: 60000,
    screenshot: true,
    keepOpen: false,
    injectTitleCrop: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--prompt') options.prompt = argv[++index];
    else if (token === '--decision') options.decision = argv[++index];
    else if (token === '--lab-home') options.labHome = argv[++index];
    else if (token === '--approval-max') options.approvalMaxMs = Number(argv[++index]);
    else if (token === '--settle-quiet') options.settleQuietMs = Number(argv[++index]);
    else if (token === '--instance-wait') options.instanceWaitMs = Number(argv[++index]);
    else if (token === '--no-screenshot') options.screenshot = false;
    else if (token === '--keep-open') options.keepOpen = true;
    else if (token === '--inject-title-crop') options.injectTitleCrop = true;
  }
  if (!['deny', 'allow'].includes(options.decision)) {
    throw new Error(`--decision 只支持 deny / allow，收到 ${options.decision}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'version') {
    process.stdout.write(`${JSON.stringify(experimentFingerprint(), null, 2)}\n`);
    return;
  }
  if (options.command === 'run') {
    if (!options.prompt) throw new Error('run 需要 --prompt "<提示词>"');
    const report = await runExperiment(options);
    process.stdout.write(`${JSON.stringify({
      experimentVersion: report.fingerprint.experimentVersion,
      approvals: report.steps?.approvals ?? [],
      turnSettled: report.steps?.turnSettled ?? null,
      disk: report.disk,
      error: report.error,
      reportPath: report.reportPath,
    }, null, 2)}\n`);
    return;
  }
  if (options.command === 'probe') {
    const report = await probeLab(options);
    process.stdout.write(`${JSON.stringify({
      experimentVersion: report.fingerprint.experimentVersion,
      localAccessLevel: report.settings?.localAccessLevel ?? null,
      channelCount: report.settings?.channelCount ?? null,
      mainWindowUrl: report.mainWindowUrl ?? null,
      composerPresent: report.composerPresent ?? null,
      launchMs: report.launchMs ?? null,
      closed: report.closed ?? false,
      error: report.error,
      reportPath: report.reportPath,
    }, null, 2)}\n`);
    return;
  }
  throw new Error(`未知命令: ${options.command}（支持 version / probe / run）`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exit(1);
  });
}
