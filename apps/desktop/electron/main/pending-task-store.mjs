import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathOf } from './data-store.mjs';

/**
 * 任务续传存储 —— 重启前把"待办任务"落盘，重启后读回并自动继续执行。
 *
 * 为什么需要它：本进程改了主进程代码后必须重启才生效，重启会中断当前会话。
 * 为了让重启后不需要用户手动说"继续"，本体在重启前把待办任务写到一个固定文件，
 * 新实例启动时主动读回、清除、并续发执行。
 *
 * 设计约束（对齐 data-store 的存储边界）：
 * - 路径不散拼：统一走 data-store 的 DATA_STORE_ENTRIES（key=pendingTask）。
 * - scope=device：这是设备本地的运行时续传状态，不跨设备迁移/导出。
 * - 读后即清（read-and-clear）：任务是一次性的，消费后立即删除，避免重复执行。
 * - 原子写：先写临时文件再 rename，避免重启竞态下读到半截 JSON。
 * - 损坏容错：解析失败不抛错、当作"无任务"，并清掉坏文件，绝不阻塞启动。
 *
 * 本模块只依赖 fs/path + data-store（不 import electron），可被单测直接 import。
 */

/**
 * 当前 schema 版本。
 * v1: 旧设计，task 仅 { prompt }（无会话坐标）。
 * v2: 会话锚定，task = { workspace, sessionId, task }（见 ADR 21）。
 * 升级版本号会使旧的 v1 记录在读取时被判为"版本不符"而丢弃，
 * 避免旧的、缺坐标的续传记录被错误恢复到当前会话。
 */
const PENDING_TASK_VERSION = 2;

function taskFilePath() {
  return pathOf('pendingTask');
}

/**
 * 写入一个待办任务。原子写：tmp -> rename。
 *
 * @param {object} task 任务负载。至少应包含续传所需的最小信息，例如：
 *   { conversationId, prompt, reason } —— 字段由调用方约定，本模块不强校验业务字段。
 * @returns {{ ok: boolean, path: string }}
 */
export function writePendingTask(task) {
  if (!task || typeof task !== 'object') {
    throw new Error('[pending-task-store] task must be a non-null object');
  }
  const file = taskFilePath();
  const payload = {
    version: PENDING_TASK_VERSION,
    createdAt: new Date().toISOString(),
    task,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, file);
  return { ok: true, path: file };
}

/** 是否存在待办任务文件（不解析内容）。 */
export function hasPendingTask() {
  return existsSync(taskFilePath());
}

/**
 * 解析待办任务文件的共用逻辑。
 *
 * @param {string} file 任务文件路径。
 * @param {{ clearOnRead: boolean }} opts
 *   clearOnRead=true：读后即清（consume 语义）。
 *   clearOnRead=false：只读不清（peek 语义）。损坏文件无论如何都清除。
 * @returns {object|null} task 负载或 null。
 */
function parsePendingTaskFile(file, { clearOnRead }) {
  if (!existsSync(file)) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // 损坏文件始终清除（无论 peek 还是 consume），避免坏文件反复阻塞启动。
    console.warn('[pending-task-store] corrupt pending task file, discarding:', error?.message ?? error);
    safeRemove(file);
    return null;
  }

  let valid = true;
  if (!parsed || typeof parsed !== 'object') {
    valid = false;
  } else if (parsed.version !== PENDING_TASK_VERSION) {
    console.warn(`[pending-task-store] unsupported version ${parsed.version}, discarding`);
    valid = false;
  } else if (!parsed.task || typeof parsed.task !== 'object') {
    valid = false;
  }

  // 清除策略：
  // - 无效内容（版本不符/结构损坏）：始终清除，避免坏文件长期残留。
  // - 有效内容：仅当 clearOnRead=true（consume）才清除；peek 保留文件。
  if (!valid || clearOnRead) {
    safeRemove(file);
  }

  return valid ? parsed.task : null;
}

/**
 * 读取并清除待办任务（read-and-clear / consume 语义）。
 *
 * - 无文件：返回 null。
 * - 文件损坏 / 版本不符：清掉坏文件，返回 null（绝不抛错阻塞启动）。
 * - 正常：删除文件后返回 task 负载。
 *
 * @returns {object|null} 写入时传入的 task 对象，或 null。
 */
export function readAndClearPendingTask() {
  return parsePendingTaskFile(taskFilePath(), { clearOnRead: true });
}

/**
 * 只读取不清除待办任务（peek 语义）。
 *
 * 用于"读和清分离"的事务化续传：启动时先 peek（文件保留），
 * 待任务真正成功发送后再调 clearPendingTask() 删除。
 * 这样即使 consume 与发送之间发生重新挂载/未就绪/崩溃，文件仍在，下次可重试，
 * 不会出现"读后即清但没发出去"导致任务被吞的情况。
 *
 * - 无文件：返回 null。
 * - 文件损坏 / 版本不符：清掉坏文件，返回 null（损坏文件不保留）。
 * - 正常：保留文件，返回 task 负载。
 *
 * @returns {object|null} 写入时传入的 task 对象，或 null。
 */
export function peekPendingTask() {
  return parsePendingTaskFile(taskFilePath(), { clearOnRead: false });
}

/** 主动清除待办任务（如用户取消续传）。无文件时 no-op。 */
export function clearPendingTask() {
  safeRemove(taskFilePath());
}

function safeRemove(file) {
  try {
    rmSync(file, { force: true });
  } catch (error) {
    console.warn('[pending-task-store] failed to remove pending task file:', error?.message ?? error);
  }
}
