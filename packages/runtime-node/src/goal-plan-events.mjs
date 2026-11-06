import { writeGoalChangeEvent } from "./goal-plan-files.mjs";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync, watch } from "node:fs";
import path from "node:path";

/** Owns durable change events, incremental subscriptions and callback lifetime through the existing store commit boundary. */
export function createGoalPlanEvents({ storeDir, onChange }) {

  const changeFile = path.join(storeDir, '.changes.jsonl');
  // onChange 可变引用：Desktop 在构造时注入；TUI 需在建好 store 之后再挂
  // auto-start 闸门（见 goal-runner-adapter），故暴露 setOnChange 修改同一引用。
  let onChangeCallback = typeof onChange === 'function' ? onChange : null;
  function setOnChange(next) {
    onChangeCallback = typeof next === 'function' ? next : null;
  }

  // 变更通知 Seam：任何写操作（create/revise/approve/setStatus/recordTaskEvidence/delete）
  // 完成后触发 onChange，使 main 进程可向 renderer 广播 'goalPlans:changed'。
  // 收口于此，AI 工具路径（local-goal-provider）与 IPC 路径共享同一通知，
  // 无需在每个调用点重复挂广播。回调异常被吞掉，绝不影响写盘结果。
  //
  // payload 契约（向后兼容扩展）：
  // - reason: 写路径标签（persist/delete/...）
  // - planId / conversationId: 供 renderer 做会话域过滤
  // - changeKind: 变更分级（persist | delete | runner-progress | runner-state）
  // - runner: runner-progress 时附带最新 runner，便于 UI 本地 patch
  function createChangePayload(reason, planId, options = {}) {
    const conversationId =
      options.conversationId !== undefined
        ? options.conversationId ?? null
        : null;
    return {
      reason,
      planId: planId ?? null,
      conversationId,
      changeKind: options.changeKind ?? reason ?? 'persist',
      ...(options.runner ? { runner: options.runner } : {}),
    };
  }

  function publishPersistedChange(reason, planId, options = {}) {
    const payload = createChangePayload(reason, planId, options);
    try {
      writeGoalChangeEvent(storeDir, payload);
    } catch (err) {
      // 外部同步失败不回滚已完成的计划写盘，但必须保留可诊断信号。
      console.warn('[goal-plan-store] change event write failed:', err);
    }
    if (options.notifyLocal === false || typeof onChangeCallback !== 'function') return;
    try {
      onChangeCallback(payload);
    } catch (err) {
      // 广播失败不影响写盘结果，但显式打印以便排查（不要静默吞）。
      console.warn('[goal-plan-store] onChange broadcast failed:', err);
    }
  }

  function notifyChanged(reason, planId, options = {}) {
    if (typeof onChangeCallback !== 'function') return;
    try {
      onChangeCallback(createChangePayload(reason, planId, options));
    } catch (err) {
      // 广播失败不影响写盘结果，但显式打印以便排查（不要静默吞）。
      console.warn('[goal-plan-store] onChange broadcast failed:', err);
    }
  }

  function subscribeChanges(listener) {
    if (typeof listener !== 'function') return () => {};
    mkdirSync(storeDir, { recursive: true });
    if (!existsSync(changeFile)) writeFileSync(changeFile, '', 'utf8');

    const currentSize = () => {
      const fd = openSync(changeFile, 'r');
      try {
        return fstatSync(fd).size;
      } finally {
        closeSync(fd);
      }
    };

    // Start at EOF: historical rows are already represented by persisted plans. Subsequent drains
    // read only appended bytes instead of repeatedly loading the entire, potentially large journal.
    let offset = currentSize();
    let pending = Buffer.alloc(0);
    let draining = false;
    let drainAgain = false;
    const drain = () => {
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      try {
        do {
          drainAgain = false;
          let fd;
          try {
            fd = openSync(changeFile, 'r');
            const size = fstatSync(fd).size;
            if (size < offset) {
              // The journal was truncated in place. Drop any incomplete row from the old file.
              offset = 0;
              pending = Buffer.alloc(0);
            }
            let remaining = size - offset;
            while (remaining > 0) {
              const chunk = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024));
              const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
              if (bytesRead <= 0) break;
              offset += bytesRead;
              remaining -= bytesRead;
              pending = pending.length > 0
                ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
                : chunk.subarray(0, bytesRead);

              let newlineIndex;
              while ((newlineIndex = pending.indexOf(0x0a)) >= 0) {
                const line = pending.subarray(0, newlineIndex).toString('utf8');
                pending = pending.subarray(newlineIndex + 1);
                if (!line.trim()) continue;
                try {
                  listener(JSON.parse(line));
                } catch {
                  // Ignore malformed rows while preserving later valid events.
                }
              }
            }
          } catch {
            // A concurrent writer may be between filesystem observations; the next event will retry.
          } finally {
            if (fd !== undefined) closeSync(fd);
          }
        } while (drainAgain);
      } finally {
        draining = false;
      }
    };
    const watcher = watch(changeFile, { persistent: false }, drain);
    // Filesystem notifications can coalesce or arrive before an append is visible.
    // Reuse the same incremental drain to recover a missed tail without replaying history.
    const fallback = setInterval(drain, 250);
    fallback.unref();
    // Close the size-snapshot → watch race without rereading historical journal bytes.
    drain();
    return () => { clearInterval(fallback); watcher.close(); };
  }
  return { subscribeChanges, notifyChanged, publishPersistedChange, setOnChange };
}
