#!/usr/bin/env node
// restart-host.mjs
//
// 安全重启 Peer Agent 本体（host / 5173 实例）的施动脚本。
//
// 背景（实测结论，见 docs/architecture/21-self-iteration-verify-handoff.md）：
//   - macOS 没有 `setsid` 命令。
//   - `nohup` / `disown` 都无法让子进程脱离本体进程树（祖先链仍含本体根）。
//   - 唯一可靠的脱离方式：用 detached 子进程 + 新 session（Node 的
//     child_process.spawn({ detached: true })，配合 unref()），使重启执行体
//     脱离本体进程树。这样在 kill 本体时，本脚本的“真正执行体”不会被一起杀掉，
//     从而能完成“杀本体 → 等端口释放 → 重新拉起本体”。
//
// 关键安全前提：
//   本脚本必须由【本体进程树之外】的施动者运行（例如 lab 实例 / 终端），
//   或者通过 --detach 让它把自己 re-spawn 成一个脱离本体进程树的执行体。
//
// 用法：
//   node scripts/restart-host.mjs --host-dir <本体工作区> --port 5173
//   node scripts/restart-host.mjs --host-dir <...> --port 5173 --detach   (自我脱离后执行)
//
// 退出码：0 表示重启流程已发起 / 完成；非 0 表示前置校验失败。

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import process from 'node:process';

// 独立日志路径：只由本脚本写，绝不与 dev server 的混合 stdout 共用文件。
// （历史教训：曾用 /tmp/peer-agent-restart-host.log，被 pnpm dev 的 [0]/[1] 输出
//  污染，导致无法判断脚本是否真的执行过。见 ADR 21。）
const LOG = '/tmp/peer-agent-restart-executor.log';
// 启动标记文件：detached 执行体一启动就写它（带 PID + 时间戳），
// 让发起方可以轮询这个文件来获得"执行体确实活着"的硬证据。
const STARTED_MARKER = '/tmp/peer-agent-restart-executor.started';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {
    // ignore log failures
  }
  // 也写 stdout，便于前台调用时观察
  process.stdout.write(line);
}

function parseArgs(argv) {
  const args = { hostDir: null, port: 5173, detach: false, settleMs: 1500 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--host-dir') args.hostDir = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--detach') args.detach = true;
    else if (a === '--settle-ms') args.settleMs = Number(argv[++i]);
  }
  return args;
}

function listenersOnPort(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 把自己 re-spawn 成一个脱离本体进程树的执行体（detached + new session）。
function reSpawnDetached(args) {
  const childArgs = [
    process.argv[1],
    '--host-dir',
    args.hostDir,
    '--port',
    String(args.port),
    '--settle-ms',
    String(args.settleMs),
    // 注意：不带 --detach，子执行体直接进入真正的重启流程
  ];
  log(`re-spawning detached executor: node ${childArgs.join(' ')}`);
  const child = spawn(process.execPath, childArgs, {
    detached: true, // 创建新进程组 + 新 session（脱离本体进程树）
    stdio: 'ignore',
    cwd: args.hostDir,
    env: process.env,
  });
  child.unref(); // 允许父进程退出而不等待子进程
  log(`detached executor spawned pid=${child.pid}; parent returning now`);
}

async function runRestart(args) {
  log('=== restart executor started (detached from host tree) ===');
  log(`host-dir=${args.hostDir} port=${args.port} pid=${process.pid}`);

  // 写启动标记：这是"执行体确实活着并进入了真正重启流程"的硬证据。
  // 发起方可轮询此文件确认 detached 没有夭折（解决"脚本是否真启动"无证据的问题）。
  try {
    writeFileSync(
      STARTED_MARKER,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: args.port }),
    );
  } catch {
    // 标记写失败不阻断重启本身。
  }

  // 1) settle：给发起方留时间干净返回
  await sleep(args.settleMs);

  // 2) 杀掉占用目标端口的本体监听进程
  const before = listenersOnPort(args.port);
  log(`listeners on ${args.port} before kill: ${before.join(', ') || '(none)'}`);
  for (const pid of before) {
    try {
      log(`SIGTERM -> ${pid}`);
      process.kill(Number(pid), 'SIGTERM');
    } catch (e) {
      log(`SIGTERM ${pid} failed: ${e.message}`);
    }
  }

  // 3) 等端口释放（最多 30s），未释放则 SIGKILL 兜底
  let released = false;
  for (let i = 0; i < 30; i += 1) {
    if (listenersOnPort(args.port).length === 0) {
      released = true;
      log(`port ${args.port} released after ${i}s`);
      break;
    }
    await sleep(1000);
  }
  if (!released) {
    const leftover = listenersOnPort(args.port);
    log(`WARN: port still busy, SIGKILL leftover: ${leftover.join(', ')}`);
    for (const pid of leftover) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await sleep(2000);
  }

  // 4) 重新拉起本体（pnpm run dev，detached，不挂在本执行体下也无妨——它已脱离本体树）
  log(`relaunching host via: pnpm run dev (cwd=${args.hostDir})`);
  const dev = spawn('pnpm', ['run', 'dev'], {
    detached: true,
    stdio: 'ignore',
    cwd: args.hostDir,
    env: process.env,
  });
  dev.unref();
  log(`host relaunch invoked, pid=${dev.pid}`);

  // 5) 等端口回来（最多 90s）
  let back = false;
  for (let i = 0; i < 90; i += 1) {
    if (listenersOnPort(args.port).length > 0) {
      back = true;
      log(`port ${args.port} LISTENING again after ${i}s — host restarted`);
      break;
    }
    await sleep(1000);
  }
  if (!back) log(`WARN: port ${args.port} not listening within 90s; inspect log`);
  log('=== restart executor finished ===');
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    writeFileSync(LOG, '');
  } catch {
    /* ignore */
  }

  if (!args.hostDir) {
    log('FATAL: --host-dir is required');
    process.exit(2);
  }

  if (args.detach) {
    // 先清掉上一次的启动标记，确保发起方轮询看到的是本次执行体写的新标记，
    // 而不是上次残留（避免"以为这次启动了，其实是旧标记"的误判）。
    try {
      unlinkSync(STARTED_MARKER);
    } catch {
      /* 不存在则忽略 */
    }
    // 第一阶段：把真正的执行体脱离出去，然后立刻返回，让发起方（可能在本体树内）干净退出。
    reSpawnDetached(args);
    log('parent (launcher) exiting; detached executor will perform restart');
    process.exit(0);
  }

  // 第二阶段：真正执行重启（应在脱离后的进程里运行）
  await runRestart(args);
}

main().catch((e) => {
  log(`FATAL: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
