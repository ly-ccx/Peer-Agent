import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const locks = new Map();
const inFlight = new Map();

function trim(value) {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function nowIso() {
  return new Date().toISOString();
}

function classifyGitError(error) {
  const message = String(error?.stderr || error?.message || error);
  if (/timed?\s*out|ETIMEDOUT/i.test(message)) return 'git_timeout';
  if (/index\.lock|unable to create .*lock|Another git process/i.test(message)) return 'git_lock';
  if (/conflict|CONFLICT|failed/i.test(message)) return 'merge_conflict';
  return null;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return String(stdout || '').trim();
  } catch (error) {
    const reason = classifyGitError(error);
    if (reason) {
      const next = new Error(reason);
      next.handoffReason = reason;
      next.cause = error;
      throw next;
    }
    throw error;
  }
}

function isCompleted(plan) {
  return plan?.status === 'completed';
}

function isQualityReady(plan) {
  if (plan?.qualityReview?.status === 'passed') return true;
  return !plan?.deliveryBinding && !plan?.targetBranch;
}

function defaultMergeTarget(plan) {
  return trim(plan?.deliveryBinding?.targetBranch) || trim(plan?.targetBranch);
}

function alreadyDelivered(plan) {
  return plan?.deliveryHandoff?.status === 'delivered';
}

/**
 * ADR 68：目标检出分支的脏检查分级。
 * 1. modified / staged（含删除、重命名）→ 挡：真有未提交工作。
 * 2. untracked 且与任务线变更集无路径碰撞 → 放行：纯噪音，merge 不碰它。
 * 3. untracked 且路径碰撞 → 比内容：与任务线将写入的版本逐字节一致 → 放行
 *    （调用方暂移后 merge 落地同一内容）；不一致 → 挡。
 * 返回 { mergeable, identicalCollisions }：identicalCollisions 是需要暂移的同内容碰撞路径。
 */
async function isTargetCheckoutMergeable(repositoryRoot, taskBranch, targetBranch) {
  const empty = { mergeable: true, identicalCollisions: [] };
  const status = await git(repositoryRoot, ['status', '--porcelain']);
  if (!status) return empty;
  const lines = status.split('\n').map((line) => line.trim()).filter(Boolean);
  const untracked = [];
  for (const line of lines) {
    // XY path：X/Y 任一非 '.' 且非 '?' 即 tracked 改动（含 staged）。
    const xy = line.slice(0, 2);
    if (xy !== '??') return { mergeable: false, identicalCollisions: [] }; // 1) 真改动
    untracked.push(line.slice(3).trim().replace(/"(.*)"/, '$1'));
  }
  if (untracked.length === 0) return empty;
  // 2) & 3) untracked：只看与任务线变更集的碰撞
  let changedPaths;
  try {
    const mergeBase = trim(await git(repositoryRoot, ['merge-base', targetBranch, taskBranch]));
    changedPaths = new Set(
      (await git(repositoryRoot, ['diff', '--name-only', `${mergeBase}..${taskBranch}`]))
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean),
    );
  } catch {
    return { mergeable: false, identicalCollisions: [] }; // 拿不到变更集时保守维持旧语义
  }
  const identicalCollisions = [];
  for (const entry of untracked) {
    // 目录条目（以 / 结尾）按前缀碰撞判定
    const collide = entry.endsWith('/')
      ? [...changedPaths].some((p) => p.startsWith(entry))
      : changedPaths.has(entry);
    if (!collide) continue; // 2) 无碰撞放行
    // 3) 碰撞比内容：untracked 文件 vs 任务线版本
    if (entry.endsWith('/')) {
      return { mergeable: false, identicalCollisions: [] }; // 目录碰撞无法逐字节比，保守挡
    }
    try {
      const [worktreeBlob, taskBlob] = await Promise.all([
        git(repositoryRoot, ['hash-object', entry]),
        git(repositoryRoot, ['rev-parse', `${taskBranch}:${entry}`]),
      ]);
      if (trim(worktreeBlob) !== trim(taskBlob)) {
        return { mergeable: false, identicalCollisions: [] }; // 内容不同：真碰撞
      }
      identicalCollisions.push(entry);
    } catch {
      return { mergeable: false, identicalCollisions: [] }; // 任务线没有该路径或命令失败：挡
    }
  }
  return { mergeable: true, identicalCollisions };
}

function alreadyStopped(plan) {
  return plan?.deliveryHandoff?.status === 'stopped';
}

async function commitWorktreeIfNeeded(worktreePath, message) {
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (!status) return git(worktreePath, ['rev-parse', 'HEAD']);
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-m', message]);
  return git(worktreePath, ['rev-parse', 'HEAD']);
}

async function mergeIntoTarget({ repositoryRoot, worktreePath, targetBranch, taskBranch, isolated = false }) {
  const checkout = await git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const mergeBase = await git(repositoryRoot, ['merge-base', targetBranch, taskBranch]);
  const targetTip = await git(repositoryRoot, ['rev-parse', targetBranch]);
  const canRebaseHere = isolated || checkout === taskBranch;
  if (mergeBase !== targetTip) {
    if (!canRebaseHere) {
      return {
        ok: false,
        reason: 'merge_conflict',
        checkout,
      };
    }
    try {
      await git(worktreePath, ['rebase', targetBranch]);
    } catch (error) {
      try {
        await git(worktreePath, ['rebase', '--abort']);
      } catch {
        // rebase may not have started; keep the original failure
      }
      return {
        ok: false,
        reason: error?.handoffReason || classifyGitError(error) || 'merge_conflict',
        checkout,
      };
    }
  }

  const occupyingTarget = checkout === targetBranch;
  if (occupyingTarget) {
    // ADR 68：脏检查分级——真改动挡，untracked 噪音只在与任务线变更集碰撞且内容不同时挡。
    const { mergeable, identicalCollisions } = await isTargetCheckoutMergeable(
      repositoryRoot,
      taskBranch,
      targetBranch,
    );
    if (!mergeable) {
      return {
        ok: false,
        reason: 'target_checkout_dirty',
        checkout,
      };
    }
    // 同内容碰撞：git merge --ff-only 对 untracked 碰撞一律拒绝（即使字节一致），
    // 先暂移，merge 成功后任务线版本落地同一内容；失败则按原字节恢复。
    const parked = [];
    try {
      for (const entry of identicalCollisions) {
        const absolute = path.join(repositoryRoot, entry);
        parked.push({ absolute, content: readFileSync(absolute) });
        rmSync(absolute);
      }
      // occupy target: merge --ff-only
      await git(repositoryRoot, ['merge', '--ff-only', taskBranch]);
      return {
        ok: true,
        commitSha: await git(repositoryRoot, ['rev-parse', 'HEAD']),
        checkout,
      };
    } catch (error) {
      for (const { absolute, content } of parked) {
        try {
          writeFileSync(absolute, content);
        } catch {
          // 恢复尽力而为；ff-only 失败时 merge 未写入任何文件
        }
      }
      return {
        ok: false,
        reason: error?.handoffReason || classifyGitError(error) || 'merge_conflict',
        checkout,
      };
    }
  }

  try {
    await git(worktreePath, ['update-ref', `refs/heads/${targetBranch}`, taskBranch]);
    return {
      ok: true,
      commitSha: await git(worktreePath, ['rev-parse', targetBranch]),
      checkout,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.handoffReason || classifyGitError(error) || 'merge_conflict',
      checkout,
    };
  }
}

export function createGoalDeliveryHandoff({
  goalPlanStore = null,
  now = nowIso,
  resolveMergeTarget = null,
} = {}) {
  function mergeTargetFor(plan) {
    if (typeof resolveMergeTarget === 'function') {
      const resolved = trim(resolveMergeTarget(plan));
      if (resolved) return resolved;
    }
    return defaultMergeTarget(plan);
  }

  function lockKey(plan) {
    const repo = trim(plan?.deliveryBinding?.targetWorkspacePath) || trim(plan?.targetWorkspacePath);
    const branch = mergeTargetFor(plan);
    if (!repo || !branch) return null;
    return `${repo}::${branch}`;
  }

  function canHandoff(plan) {
    if (!plan || typeof plan !== 'object') return false;
    if (!isCompleted(plan)) return false;
    if (!isQualityReady(plan)) return false;
    const binding = plan.deliveryBinding;
    if (!binding) return false;
    const taskBranch = trim(binding.taskBranch);
    const targetBranch = mergeTargetFor(plan);
    if (!taskBranch || !targetBranch) return false;
    // 完成即结束：没开隔离的改动留在当前工作区，不合回。
    // 只有独立 Worktree 才在完成后把任务线合回目标分支。
    return binding.executionIsolation === 'worktree' && Boolean(trim(binding.worktreePath));
  }

  /**
   * ADR 68：direct 交付事实判定。
   * 非隔离计划完成且质量过关时，改动已直接落在当前工作区——写入 delivered 事实，
   * UI 不再从「无记录」反推「还没进」。幂等：已有 handoff 记录的计划不覆盖。
   */
  function canRecordDirectDelivery(plan) {
    if (!plan || typeof plan !== 'object') return false;
    if (!isCompleted(plan)) return false;
    if (!isQualityReady(plan)) return false;
    const binding = plan.deliveryBinding;
    if (!binding) return false;
    if (plan.deliveryHandoff?.status) return false; // 幂等：不覆盖已有状态（含 stopped 重试中）
    if (binding.executionIsolation === 'worktree') return false; // 隔离走合回链路
    return Boolean(trim(binding.targetBranch) || trim(plan.targetBranch));
  }

  /**
   * ADR 68：direct 交付的 git 级验证。
   * 只有当「任务线上没有未合入目标分支的工作」时，才允许把完成事实记为 direct delivered：
   * - 任务线不存在 → 没有待合回的工作（Fix 4 之后非隔离不再建任务线）；
   * - 任务线完全包含在目标分支里（空壳停在 base，或已并入）→ 同样没有待合回的工作。
   * 任务线有独立提交（工作还没进目标分支）时不记录——那不是 direct 交付，是未交付。
   */
  async function verifyDirectDeliveryLanded(repositoryRoot, taskBranch, targetBranch) {
    if (taskBranch) {
      try {
        await git(repositoryRoot, ['rev-parse', '--verify', `refs/heads/${taskBranch}`]);
      } catch {
        return true; // 任务线不存在
      }
      try {
        const mergeBase = trim(await git(repositoryRoot, ['merge-base', taskBranch, targetBranch]));
        const taskHead = trim(await git(repositoryRoot, ['rev-parse', taskBranch]));
        return mergeBase === taskHead;
      } catch {
        return false; // 无法判定时保守跳过，不写事实
      }
    }
    try {
      const checkout = trim(await git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']));
      return checkout === targetBranch; // 无任务线：工作只能落在当前检出分支
    } catch {
      return false;
    }
  }

  async function recordDirectDelivery(plan) {
    const binding = plan.deliveryBinding || {};
    const repositoryRoot = trim(binding.targetWorkspacePath) || trim(plan.targetWorkspacePath);
    const targetBranch = mergeTargetFor(plan);
    if (!repositoryRoot || !existsSync(repositoryRoot) || !targetBranch) return plan;
    if (!(await verifyDirectDeliveryLanded(repositoryRoot, trim(binding.taskBranch), targetBranch))) {
      return plan;
    }
    let commitSha = null;
    try {
      commitSha = trim(await git(repositoryRoot, ['rev-parse', 'HEAD']));
    } catch {
      commitSha = null; // 取不到 HEAD 不阻断事实写入，只缺 commitSha
    }
    return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
      status: 'delivered',
      deliveryMode: 'direct',
      repoId: binding.repoId,
      targetBranch,
      taskBranch: trim(binding.taskBranch) || undefined,
      commitSha: commitSha || undefined,
      updatedAt: now(),
    }) || plan;
  }

  function stopPlan(plan, reason, extras = {}) {
    const binding = plan.deliveryBinding || {};
    return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
      status: 'stopped',
      repoId: binding.repoId,
      targetBranch: extras.targetBranch || trim(binding.targetBranch),
      taskBranch: extras.taskBranch || trim(binding.taskBranch),
      stoppedReason: reason,
      updatedAt: now(),
      ...extras,
    }) || plan;
  }

  async function runHandoff(plan) {
    if (!canHandoff(plan) || alreadyDelivered(plan)) return plan;
    const binding = plan.deliveryBinding;
    const repositoryRoot = trim(binding.targetWorkspacePath) || trim(plan.targetWorkspacePath);
    const worktreePath = trim(binding.worktreePath);
    const targetBranch = mergeTargetFor(plan);
    const taskBranch = trim(binding.taskBranch);
    const isolated = binding.executionIsolation === 'worktree';
    const operationRoot = isolated ? worktreePath : repositoryRoot;
    if (!repositoryRoot || !existsSync(repositoryRoot)) return plan;
    if (!operationRoot || !existsSync(operationRoot)) return plan;
    if (isolated && (!worktreePath || !existsSync(worktreePath))) return plan;

    const key = lockKey(plan);
    if (!key) return plan;
    const existing = locks.get(key);
    if (existing && existing.planId !== plan.planId) {
      return stopPlan(plan, 'same_target_busy', { targetBranch, taskBranch });
    }

    const delivering = goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
      status: 'delivering',
      repoId: binding.repoId,
      targetBranch,
      taskBranch,
      updatedAt: now(),
    }) || plan;

    try {
      const checkout = await git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const canCommitHere = isolated || checkout === taskBranch;
      const commitSha = canCommitHere
        ? await commitWorktreeIfNeeded(
          operationRoot,
          `Peer Agent handoff ${plan.planId}`,
        )
        : await git(repositoryRoot, ['rev-parse', taskBranch]);
      const merged = await mergeIntoTarget({
        repositoryRoot,
        worktreePath: operationRoot,
        targetBranch,
        taskBranch,
        isolated,
      });
      if (!merged.ok) {
        return stopPlan(delivering, merged.reason, {
          targetBranch,
          taskBranch,
          commitSha,
        });
      }
      return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
        status: 'delivered',
        repoId: binding.repoId,
        targetBranch,
        taskBranch,
        commitSha: merged.commitSha || commitSha,
        updatedAt: now(),
      }) || delivering;
    } catch (error) {
      return stopPlan(delivering, error?.handoffReason || String(error?.message || error), {
        targetBranch,
        taskBranch,
      });
    }
  }

  function handoffPlan(plan, { retry = false } = {}) {
    if (!plan || typeof plan !== 'object') return Promise.resolve(plan);
    if (!canHandoff(plan) || alreadyDelivered(plan)) {
      // ADR 68：非隔离计划没有合回动作，但完成即已直接交付——补写事实（幂等）。
      if (canRecordDirectDelivery(plan)) {
        return recordDirectDelivery(plan).catch((error) => {
          console.warn('[goal-handoff] direct delivery record failed:', error?.message || error);
          return plan;
        });
      }
      return Promise.resolve(plan);
    }
    if (alreadyStopped(plan) && !retry) return Promise.resolve(plan);

    const existing = inFlight.get(plan.planId);
    if (existing) return existing;

    const key = lockKey(plan);
    if (key) {
      const holder = locks.get(key);
      if (holder && holder.planId !== plan.planId) {
        return Promise.resolve(stopPlan(plan, 'same_target_busy', {
          targetBranch: trim(plan.deliveryBinding?.targetBranch),
          taskBranch: trim(plan.deliveryBinding?.taskBranch),
        }));
      }
      locks.set(key, { planId: plan.planId });
    }
    const task = (async () => {
      try {
        return await runHandoff(plan);
      } finally {
        if (key && locks.get(key)?.planId === plan.planId) locks.delete(key);
      }
    })().finally(() => {
      if (inFlight.get(plan.planId) === task) inFlight.delete(plan.planId);
    });
    inFlight.set(plan.planId, task);
    return task;
  }

  async function retryHandoff(plan) {
    return handoffPlan(plan, { retry: true });
  }

  return Object.freeze({
    canHandoff,
    canRecordDirectDelivery,
    recordDirectDelivery,
    lockKey,
    handoffPlan,
    retryHandoff,
  });
}
