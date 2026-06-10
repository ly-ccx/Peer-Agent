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
 * - 路径不散拼：统一走 data-store 的 ZEUS_ENTRIES（key=pendingTask）。
 * - scope=device：这是设备本地的运行时续传状态，不跨设备迁移/导出。
 * - 读后即清（read-and-clear）：任务是一次性的，消费后立即删除，避免重复执行。
 * - 原子写：先写临时文件再 rename，避免重启竞态下读到半截 JSON。
 * - 损坏容错：解析失败不抛错、当作"无任务"，并清掉坏文件，绝不阻塞启动。
 *
 * 本模块只依赖 fs/path + data-store（不 import electron），可被单测直接 import。
 */

/** 当前 schema 版本，便于将来字段演进时做兼容判断。 */
const PENDING_TASK_VERSION = 1;

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
 * 读取并清除待办任务（read-and-clear）。
 *
 * - 无文件：返回 null。
 * - 文件损坏 / 版本不符：清掉坏文件，返回 null（绝不抛错阻塞启动）。
 * - 正常：删除文件后返回 task 负载。
 *
 * @returns {object|null} 写入时传入的 task 对象，或 null。
 */
export function readAndClearPendingTask() {
  const file = taskFilePath();
  if (!existsSync(file)) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn('[pending-task-store] corrupt pending task file, discarding:', error?.message ?? error);
    safeRemove(file);
    return null;
  }

  // 消费即删：无论后续校验是否通过，文件都不应再保留。
  safeRemove(file);

  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version !== PENDING_TASK_VERSION) {
    console.warn(`[pending-task-store] unsupported version ${parsed.version}, discarding`);
    return null;
  }
  if (!parsed.task || typeof parsed.task !== 'object') return null;
  return parsed.task;
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
