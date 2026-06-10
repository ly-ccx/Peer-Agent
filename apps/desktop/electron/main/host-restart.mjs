// host-restart.mjs
//
// M3 of docs/architecture/21-self-iteration-verify-handoff.md
//
// 把"由实验体(lab)重启本体(host)"从手敲命令收口为一个程序化入口。
//
// 设计要点（实测结论见 ADR 21）：
//   - 施动者必须在本体进程树之外。lab 实例天然满足（它是另一棵进程树）。
//   - 真正的重启执行体由 scripts/restart-host.mjs 在 --detach 模式下自我脱离完成；
//     本模块只负责"定位脚本 + 以 detached 方式发起 launcher"，然后立即返回。
//   - 本模块不杀任何进程、不直接操作端口；危险动作全部委托给已实测的
//     restart-host.mjs，保持单一可信执行路径。
//
// Interface:
//   createHostRestarter({ workspaceRoot }) -> { restartHost(options) }
//     restartHost({ hostDir, port }) -> Promise<{ ok, launcherPid, scriptPath, hostDir, port }>
//       - hostDir: 本体工作区绝对路径（必填）。
//       - port:    本体 dev 端口，默认 5173。
//   失败时抛出带明确 code 的 Error（host_restart_*），便于 IPC 层透传给调用方。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PORT = 5173;

/**
 * 在若干候选位置里定位 restart-host.mjs。
 * @param {string} workspaceRoot - 当前实例(lab)的工作区根。
 * @returns {string} 脚本绝对路径
 */
function resolveRestartScript(workspaceRoot) {
  const candidates = [
    workspaceRoot ? path.join(workspaceRoot, 'scripts', 'restart-host.mjs') : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const tried = candidates.join(', ') || '(none)';
  const err = new Error(`host_restart_script_not_found: tried ${tried}`);
  err.code = 'host_restart_script_not_found';
  throw err;
}

export function createHostRestarter({ workspaceRoot } = {}) {
  async function restartHost(options = {}) {
    const hostDir = options.hostDir;
    const port = Number(options.port) || DEFAULT_PORT;

    if (!hostDir) {
      const err = new Error('host_restart_missing_host_dir');
      err.code = 'host_restart_missing_host_dir';
      throw err;
    }
    if (!existsSync(hostDir)) {
      const err = new Error(`host_restart_host_dir_not_found: ${hostDir}`);
      err.code = 'host_restart_host_dir_not_found';
      throw err;
    }

    const scriptPath = resolveRestartScript(workspaceRoot);

    // detached launcher：restart-host.mjs --detach 会把真正的执行体再脱离一次，
    // 然后立即 exit(0)。这里我们也用 detached + unref，确保本体被杀时本调用早已返回。
    const child = spawn(
      process.execPath,
      [scriptPath, '--host-dir', hostDir, '--port', String(port), '--detach'],
      {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    child.unref();

    return {
      ok: true,
      launcherPid: child.pid ?? null,
      scriptPath,
      hostDir,
      port,
    };
  }

  return { restartHost };
}
