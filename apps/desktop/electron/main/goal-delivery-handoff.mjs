import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
  if (/conflict|CONFLICT/i.test(message)) return 'merge_conflict';
  return null;
}

function parseConflictPathsFromText(text) {
  const paths = [];
  const seen = new Set();
  const blob = String(text || '');
  const patterns = [
    /^(?:CONFLICT(?:\s*\([^)]+\))?|CONFLICTING):\s+(?:Merge conflict in |content conflict in )?(.+)$/gim,
    /^Auto-merging (.+)$/gim,
  ];
  for (const pattern of patterns) {
    for (const match of blob.matchAll(pattern)) {
      const next = String(match[1] || '').trim();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      paths.push(next);
    }
  }
  return paths;
}

async function listUnmergedConflicts(cwd) {
  const paths = new Set();
  try {
    const raw = await gitRaw(cwd, ['ls-files', '-u', '-z']);
    for (const entry of String(raw || '').split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      const filePath = tab >= 0 ? entry.slice(tab + 1) : '';
      if (filePath) paths.add(filePath);
    }
  } catch {
    // 冲突清单尽力而为；abort 之后就读不到了。
  }
  try {
    const diff = await gitRaw(cwd, ['diff', '--name-only', '--diff-filter=U']);
    for (const line of String(diff || '').split('\n')) {
      const filePath = line.trim();
      if (filePath) paths.add(filePath);
    }
  } catch {
    // ignore
  }
  return [...paths].map((filePath) => ({ path: filePath }));
}

function conflictStop({ reason = 'merge_conflict', checkout, error, conflicts } = {}) {
  const stoppedReason = reason || classifyGitError(error) || 'merge_conflict';
  const fromError = parseConflictPathsFromText(gitErrorText(error));
  const listed = Array.isArray(conflicts) ? conflicts.map((item) => item?.path).filter(Boolean) : [];
  const paths = [...new Set([...listed, ...fromError])];
  return {
    ok: false,
    reason: stoppedReason,
    checkout,
    verdict: 'CONFLICT',
    ...(paths.length ? { conflicts: paths.map((filePath) => ({ path: filePath })) } : {}),
  };
}

function gitErrorText(error) {
  const parts = [
    error?.stderr,
    error?.stdout,
    error?.cause?.stderr,
    error?.cause?.message,
    error?.message,
  ].filter((value) => typeof value === 'string' && value.trim());
  return parts.join('\n').trim() || String(error || '');
}

async function gitRaw(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return String(stdout || '');
}

async function git(cwd, args) {
  try {
    return (await gitRaw(cwd, args)).trim();
  } catch (error) {
    const reason = classifyGitError(error);
    if (reason) {
      const next = new Error(reason);
      next.handoffReason = reason;
      next.stderr = error?.stderr;
      next.stdout = error?.stdout;
      next.cause = error;
      throw next;
    }
    throw error;
  }
}

/** 取 git 输出的原始字节（不 trim），用于 keep_both 完整落地任务线文件内容。 */
async function gitBuffer(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
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

function parsePorcelainPath(line) {
  return line.slice(3).trim().replace(/^"(.*)"$/, '$1');
}

/**
 * 源头环境挡：列出目标工作区挡路的 tracked 改动（不含未跟踪噪音）。
 */
export async function inspectSourceCheckout({ repositoryRoot, gitRunner = git }) {
  if (!repositoryRoot) return { ok: false, reason: 'missing_workspace' };
  try {
    const branch = trim(await gitRunner(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']));
    const rawStatus = gitRunner === git
      ? await gitRaw(repositoryRoot, ['status', '--porcelain', '-uall'])
      : await gitRunner(repositoryRoot, ['status', '--porcelain', '-uall']);
    const files = String(rawStatus || '')
      .split('\n')
      .filter((line) => line.length >= 4)
      .filter((line) => line.slice(0, 2) !== '??')
      .map((line) => ({ path: parsePorcelainPath(line), status: line.slice(0, 2).trim() || line.slice(0, 2) }))
      .filter((entry) => entry.path);
    return { ok: true, branch, files };
  } catch (error) {
    return { ok: false, reason: 'inspect_failed', detail: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * 提交源头挡路的 tracked 改动。不把未跟踪噪音加进去。
 */
export async function commitSourceCheckout({ repositoryRoot, message, gitRunner = git }) {
  if (!repositoryRoot) return { ok: false, reason: 'missing_workspace' };
  const run = gitRunner === git
    ? (args) => gitRaw(repositoryRoot, args)
    : (args) => gitRunner(repositoryRoot, args);
  try {
    await run(['add', '-u']);
  } catch (error) {
    return { ok: false, reason: 'commit_failed', detail: gitErrorText(error).slice(0, 300) };
  }
  const commitMessage = trim(message) || 'chore: commit blocking work on the source line';
  try {
    await run(['commit', '-m', commitMessage]);
    return { ok: true };
  } catch (error) {
    const detail = gitErrorText(error);
    if (/nothing to commit/i.test(detail)) return { ok: true, reason: 'nothing_to_commit' };
    return { ok: false, reason: 'commit_failed', detail: detail.slice(0, 300) };
  }
}

/**
 * 把源头未提交工作先放下，好让任务线合进来。
 */
export async function stashSourceCheckout({ repositoryRoot, gitRunner = git }) {
  if (!repositoryRoot) return { ok: false, reason: 'missing_workspace' };
  try {
    await gitRunner(repositoryRoot, ['stash', 'push', '-m', 'peer: park source checkout to merge task lines']);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'stash_failed', detail: String(error?.message || error).slice(0, 300) };
  }
}

/** 把绝对/相对路径规整为仓库内相对路径；越界返回 null（防路径逃逸）。 */
function relPath(repositoryRoot, p) {
  if (!p || typeof p !== 'string') return null;
  const rel = path.isAbsolute(p) ? path.relative(repositoryRoot, p) : p;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * ADR 69 P2：按用户决断执行收口。仅处理「目标分支被工作区占用 + 未跟踪同名文件内容不同」的冲突。
 * resolutions: [{ path, choice }]，choice ∈ keep_taskline | keep_worktree | keep_both。
 *  - keep_taskline：暂移工作区版为 <path>.worktree-backup，ff-only 合并任务线，任务线版落地（动 git 目标线）。
 *  - keep_worktree：不动 git，只把该线标记为已决（内容已在工作区，线可另行删除）。
 *  - keep_both：任务线版另存为 <path>.taskline，工作区版保留，不合并目标线。
 * 全部为 keep_taskline 且合并成功 → delivered；否则标记 conflict_resolved 停在原地。
 */
export async function resolveHandoffConflicts({ plan, resolutions, gitRunner = git }) {
  const binding = plan?.deliveryBinding || {};
  const repositoryRoot = trim(binding.targetWorkspacePath) || trim(plan?.targetWorkspacePath);
  const targetBranch = trim(binding.targetBranch);
  const taskBranch = trim(binding.taskBranch);
  if (!repositoryRoot || !targetBranch || !taskBranch) return { ok: false, reason: 'missing_binding' };
  const conflicts = plan?.deliveryHandoff?.conflicts || [];
  const conflictPaths = new Set(conflicts.map((c) => c.path));
  const applied = [];
  const parked = []; // keep_taskline 待合并时被暂移的工作区文件（合并失败需恢复）
  let needsMerge = false;
  try {
    for (const r of resolutions || []) {
      const rel = relPath(repositoryRoot, r?.path);
      if (!rel || !conflictPaths.has(rel)) return { ok: false, reason: 'unknown_conflict_path', path: r?.path };
      const abs = path.join(repositoryRoot, rel);
      if (r.choice === 'keep_taskline') {
        const content = readFileSync(abs); // 工作区版字节，备份 + 失败恢复用
        renameSync(abs, `${abs}.worktree-backup`);
        parked.push({ abs, content });
        needsMerge = true;
        applied.push({ path: rel, choice: r.choice });
      } else if (r.choice === 'keep_both') {
        const taskContent = await gitBuffer(repositoryRoot, ['show', `${taskBranch}:${rel}`]); // 原始字节，保留尾部换行
        writeFileSync(`${abs}.taskline`, taskContent);
        applied.push({ path: rel, choice: r.choice });
      } else { // keep_worktree：不动文件
        applied.push({ path: rel, choice: 'keep_worktree' });
      }
    }
    if (needsMerge) {
      try {
        await gitRunner(repositoryRoot, ['merge', '--ff-only', taskBranch]);
      } catch (error) {
        for (const { abs, content } of parked) { try { writeFileSync(abs, content); } catch { /* 尽力恢复 */ } }
        return { ok: false, reason: 'merge_failed', detail: String(error?.message || error).slice(0, 300) };
      }
      const allTaskline = applied.every((a) => a.choice === 'keep_taskline');
      if (allTaskline) {
        const commitSha = trim(await gitRunner(repositoryRoot, ['rev-parse', 'HEAD']));
        return { ok: true, delivered: true, commitSha, applied };
      }
    }
    return { ok: true, delivered: false, applied };
  } catch (error) {
    return { ok: false, reason: 'resolve_failed', detail: String(error?.message || error).slice(0, 300) };
  }
}

/**
 * ADR 69 P2：真机预览「合并后的目标线」。检出任务线到临时 worktree 供预览，不动主工作区。
 * resolutions 里 keep_worktree 的路径在预览中以工作区版本覆盖（模拟取舍后的样子）。
 * 返回 { previewPath }；调用方负责用同一函数传 cleanupOnly 或事后 rm 清理。
 */
export async function previewHandoffMerge({ plan, resolutions = [], gitRunner = git }) {
  const binding = plan?.deliveryBinding || {};
  const repositoryRoot = trim(binding.targetWorkspacePath) || trim(plan?.targetWorkspacePath);
  const targetBranch = trim(binding.targetBranch);
  const taskBranch = trim(binding.taskBranch);
  if (!repositoryRoot || !taskBranch) return { ok: false, reason: 'missing_binding' };
  const previewPath = path.join(os.tmpdir(), `peer-handoff-preview-${Date.now()}`);
  try {
    await gitRunner(repositoryRoot, ['worktree', 'add', '--detach', previewPath, taskBranch]);
    for (const r of resolutions || []) {
      const rel = relPath(repositoryRoot, r?.path);
      if (!rel) continue;
      if (r.choice === 'keep_worktree') {
        const src = path.join(repositoryRoot, rel);
        const dest = path.join(previewPath, rel);
        if (existsSync(src)) {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, readFileSync(src));
        }
      }
    }
    return { ok: true, previewPath, targetBranch };
  } catch (error) {
    try { await gitRunner(repositoryRoot, ['worktree', 'remove', '--force', previewPath]); } catch { /* 忽略清理失败 */ }
    return { ok: false, reason: 'preview_failed', detail: String(error?.message || error).slice(0, 300) };
  }
}

/** 清理预览 worktree（渲染层关闭预览时调用）。 */
export async function cleanupHandoffPreview({ repositoryRoot, previewPath, gitRunner = git }) {
  if (!repositoryRoot || !previewPath) return { ok: false };
  try {
    await gitRunner(repositoryRoot, ['worktree', 'remove', '--force', previewPath]);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'cleanup_failed', detail: String(error?.message || error).slice(0, 200) };
  }
}

/**
 * ADR 69：合回分流（Triage）分类器——结构化 verdict 替代布尔判定。
 * 对每条任务线判定一次，输出五类处置，让空壳/同内容/过时被系统自动消化，
 * 只有真冲突浮现给用户。验收对象从 O(n) 条任务线收敛为 O(1) 个目标线最终态。
 *
 * 判定顺序（先判无需用户的情形，把 CONFLICT 留到最后）：
 *   AUTO_CLEAN  空壳：ahead===0，改动早已合进目标线，静默清理。先于脏检查。
 *   BLOCKED_ENV 环境挡：tracked 脏 / merge-base·diff 失败，需用户先处理环境。
 *   CONFLICT    真冲突：同名未跟踪文件内容与任务线版本不同，合并会覆盖。
 *   AUTO_MERGE  可自动合：无 tracked 脏，碰撞仅同内容未跟踪文件（或无碰撞）。
 *   STALE       已过时：behind 超阈值且改动相对目标线当前内容已失效（另案细化）。
 */

/** 落后多少提交视为「已过时」候选阈值（STALE 的进一步失效判定见 detail）。 */
const STALE_BEHIND_THRESHOLD = 20;

export async function triageTaskLine({ repositoryRoot, taskBranch, targetBranch, gitRunner = git }) {
  const base = {
    reason: '',
    detail: { ahead: 0, behind: 0, changedFiles: [], collisions: [], blockingEntry: null },
  };

  // 任务线相对目标线的领先/落后与变更集。空壳必须先于脏检查：
  // ahead=0 时工作区脏挡的是别人的未提交改动，不是这条任务线。
  let ahead; let behind; let changedFiles; let mergeBase;
  try {
    mergeBase = trim(await gitRunner(repositoryRoot, ['merge-base', targetBranch, taskBranch]));
    ahead = Number(trim(await gitRunner(repositoryRoot, ['rev-list', '--count', `${targetBranch}..${taskBranch}`]))) || 0;
    behind = Number(trim(await gitRunner(repositoryRoot, ['rev-list', '--count', `${taskBranch}..${targetBranch}`]))) || 0;
    changedFiles = (await gitRunner(repositoryRoot, ['diff', '--name-only', `${mergeBase}..${taskBranch}`]))
      .split('\n').map((p) => p.trim()).filter(Boolean);
  } catch {
    return { ...base, verdict: 'BLOCKED_ENV', reason: 'git_query_failed', detail: { ...base.detail, blockingEntry: 'merge-base/diff failed' } };
  }
  base.detail.ahead = ahead;
  base.detail.behind = behind;
  base.detail.changedFiles = changedFiles;

  // 空壳：任务线相对目标线无领先（改动已合进目标线）。
  if (ahead === 0) {
    return { ...base, verdict: 'AUTO_CLEAN', reason: 'empty_shell_already_landed' };
  }

  // -uall：默认模式会把全未跟踪目录折叠成目录条目（如 demo/），无法对单文件
  // 做碰撞与逐字节内容比对。展开到单文件后逐字节比对才能命中（ADR 69 / P0 修复）。
  const status = await gitRunner(repositoryRoot, ['status', '--porcelain', '-uall']);
  const lines = status.split('\n').map((line) => line.trim()).filter(Boolean);
  const untracked = [];
  for (const line of lines) {
    const xy = line.slice(0, 2);
    if (xy !== '??') {
      // tracked 脏（modified/staged/deleted/renamed）：环境挡，真有未提交工作。
      return { ...base, verdict: 'BLOCKED_ENV', reason: 'target_checkout_dirty', detail: { ...base.detail, blockingEntry: line.slice(3).trim() } };
    }
    untracked.push(line.slice(3).trim().replace(/"(.*)"/, '$1'));
  }

  // 与目标工作区未跟踪文件的碰撞比对（逐字节）。
  const collisions = [];
  for (const entry of untracked) {
    if (!changedFiles.includes(entry)) continue; // 无碰撞：纯噪音，merge 不碰它
    try {
      const [worktreeBlob, taskBlob] = await Promise.all([
        gitRunner(repositoryRoot, ['hash-object', entry]),
        gitRunner(repositoryRoot, ['rev-parse', `${taskBranch}:${entry}`]),
      ]);
      const identical = trim(worktreeBlob) === trim(taskBlob);
      collisions.push({ path: entry, kind: identical ? 'identical' : 'different' });
    } catch {
      collisions.push({ path: entry, kind: 'different' }); // 比对失败按真碰撞保守处理
    }
  }
  base.detail.collisions = collisions;

  if (collisions.some((c) => c.kind === 'different')) {
    // 真冲突：合并会覆盖工作区内容，必须用户决断。
    return { ...base, verdict: 'CONFLICT', reason: 'untracked_content_differs' };
  }
  if (collisions.length > 0 || untracked.length === 0) {
    // 可自动合：无冲突，碰撞均为同内容（调用方暂移后 ff-only 落地同一内容）。
    return { ...base, verdict: 'AUTO_MERGE', reason: collisions.length > 0 ? 'identical_collisions' : 'clean' };
  }
  // 无碰撞但有变更集：干净快进。
  return { ...base, verdict: 'AUTO_MERGE', reason: 'clean' };
}

/**
 * ADR 68：目标检出分支的脏检查分级。
 * 1. modified / staged（含删除、重命名）→ 挡：真有未提交工作。
 * 2. untracked 且与任务线变更集无路径碰撞 → 放行：纯噪音，merge 不碰它。
 * 3. untracked 且路径碰撞 → 比内容：与任务线将写入的版本逐字节一致 → 放行
 *    （调用方暂移后 merge 落地同一内容）；不一致 → 挡。
 * 返回 { mergeable, identicalCollisions }：identicalCollisions 是需要暂移的同内容碰撞路径。
 *
 * ADR 69：实现升级为 triageTaskLine 的薄封装——mergeable 等价于
 * verdict === 'AUTO_MERGE'，identicalCollisions 取自 detail.collisions 中同内容项。
 */
async function isTargetCheckoutMergeable(repositoryRoot, taskBranch, targetBranch) {
  const triage = await triageTaskLine({ repositoryRoot, taskBranch, targetBranch });
  const identicalCollisions = triage.detail.collisions.filter((c) => c.kind === 'identical').map((c) => c.path);
  return { mergeable: triage.verdict === 'AUTO_MERGE', identicalCollisions, triage };
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
      return conflictStop({ reason: 'merge_conflict', checkout });
    }
    try {
      await git(worktreePath, ['rebase', targetBranch]);
    } catch (error) {
      const conflicts = await listUnmergedConflicts(worktreePath);
      try {
        await git(worktreePath, ['rebase', '--abort']);
      } catch {
        // rebase may not have started; keep the original failure
      }
      return conflictStop({
        reason: error?.handoffReason || classifyGitError(error) || 'merge_conflict',
        checkout,
        error,
        conflicts,
      });
    }
  }

  const occupyingTarget = checkout === targetBranch;
  if (occupyingTarget) {
    // ADR 68：脏检查分级——真改动挡，untracked 噪音只在与任务线变更集碰撞且内容不同时挡。
    // ADR 69：isTargetCheckoutMergeable 内部即 triageTaskLine，triage 携带五类 verdict 与冲突清单。
    const { mergeable, identicalCollisions, triage } = await isTargetCheckoutMergeable(
      repositoryRoot,
      taskBranch,
      targetBranch,
    );
    if (triage?.verdict === 'AUTO_CLEAN') {
      // 空壳：任务线已在目标线里，工作区脏挡不住「已进」事实。
      return {
        ok: true,
        alreadyLanded: true,
        commitSha: await git(repositoryRoot, ['rev-parse', targetBranch]),
        checkout,
        verdict: 'AUTO_CLEAN',
      };
    }
    if (!mergeable) {
      // CONFLICT：同名未跟踪文件内容不同，合并会覆盖工作区——透出冲突清单供收口视图呈现。
      // BLOCKED_ENV（tracked 脏/查询失败）：维持原 stoppedReason，不附冲突清单。
      const isConflict = triage?.verdict === 'CONFLICT';
      return {
        ok: false,
        reason: isConflict ? 'merge_conflict_untracked' : 'target_checkout_dirty',
        checkout,
        verdict: triage?.verdict,
        conflicts: isConflict
          ? triage.detail.collisions.filter((c) => c.kind === 'different').map((c) => ({ path: c.path }))
          : undefined,
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
      const conflicts = await listUnmergedConflicts(repositoryRoot);
      for (const { absolute, content } of parked) {
        try {
          writeFileSync(absolute, content);
        } catch {
          // 恢复尽力而为；ff-only 失败时 merge 未写入任何文件
        }
      }
      const reason = error?.handoffReason || classifyGitError(error) || 'merge_conflict';
      if (reason === 'merge_conflict' || reason === 'merge_conflict_untracked') {
        return conflictStop({ reason, checkout, error, conflicts });
      }
      return {
        ok: false,
        reason,
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
    const reason = error?.handoffReason || classifyGitError(error) || 'merge_conflict';
    if (reason === 'merge_conflict' || reason === 'merge_conflict_untracked') {
      return conflictStop({ reason, checkout, error });
    }
    return {
      ok: false,
      reason,
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

  function handoffGateReason(plan) {
    if (!plan || typeof plan !== 'object') return 'missing_plan';
    if (!isCompleted(plan)) return 'plan_not_completed';
    if (!isQualityReady(plan)) return 'quality_review_pending';
    const binding = plan.deliveryBinding;
    if (!binding) return 'missing_binding';
    const taskBranch = trim(binding.taskBranch);
    const targetBranch = mergeTargetFor(plan);
    if (!taskBranch || !targetBranch) return 'missing_binding';
    if (!(binding.executionIsolation === 'worktree' && Boolean(trim(binding.worktreePath)))) {
      return 'missing_worktree';
    }
    return null;
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
    if (isolated && (!worktreePath || !existsSync(worktreePath))) {
      return stopPlan(plan, 'missing_worktree', { targetBranch, taskBranch });
    }

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
          ...(merged.verdict ? { verdict: merged.verdict } : {}),
          ...(merged.conflicts ? { conflicts: merged.conflicts } : {}),
        });
      }
      return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
        status: 'delivered',
        repoId: binding.repoId,
        targetBranch,
        taskBranch,
        commitSha: merged.commitSha || commitSha,
        ...(merged.verdict ? { verdict: merged.verdict } : {}),
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
    if (alreadyDelivered(plan)) return Promise.resolve(plan);
    if (!canHandoff(plan)) {
      // ADR 68：非隔离计划没有合回动作，但完成即已直接交付——补写事实（幂等）。
      if (canRecordDirectDelivery(plan)) {
        return recordDirectDelivery(plan).catch((error) => {
          console.warn('[goal-handoff] direct delivery record failed:', error?.message || error);
          return plan;
        });
      }
      if (retry) {
        const reason = handoffGateReason(plan);
        if (reason) return Promise.resolve(stopPlan(plan, reason));
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

  async function inspectSource(plan, { repositoryRoot } = {}) {
    const binding = plan?.deliveryBinding || {};
    const root = trim(repositoryRoot)
      || trim(binding.targetWorkspacePath)
      || trim(plan?.targetWorkspacePath);
    return inspectSourceCheckout({ repositoryRoot: root });
  }

  async function commitSource(plan, { message, permissionConfirmed = false, repositoryRoot } = {}) {
    if (!permissionConfirmed) return { ok: false, reason: 'permission_required' };
    const binding = plan?.deliveryBinding || {};
    const root = trim(repositoryRoot)
      || trim(binding.targetWorkspacePath)
      || trim(plan?.targetWorkspacePath);
    return commitSourceCheckout({ repositoryRoot: root, message });
  }

  async function stashSource(plan, { permissionConfirmed = false, repositoryRoot } = {}) {
    if (!permissionConfirmed) return { ok: false, reason: 'permission_required' };
    const binding = plan?.deliveryBinding || {};
    const root = trim(repositoryRoot)
      || trim(binding.targetWorkspacePath)
      || trim(plan?.targetWorkspacePath);
    return stashSourceCheckout({ repositoryRoot: root });
  }

  async function retryHandoffs(plans) {
    const list = Array.isArray(plans) ? plans.filter((plan) => plan?.planId) : [];
    const results = [];
    for (const plan of list) {
      try {
        const next = await retryHandoff(plan);
        results.push({
          planId: plan.planId,
          ok: next?.deliveryHandoff?.status === 'delivered',
          status: next?.deliveryHandoff?.status,
          verdict: next?.deliveryHandoff?.verdict,
        });
      } catch (error) {
        results.push({
          planId: plan.planId,
          ok: false,
          reason: String(error?.message || error).slice(0, 200),
        });
      }
    }
    return { ok: true, results };
  }

  // ADR 69 P2：收口决断执行。permissionConfirmed 由 main 经 PermissionGrant 批准后传入。
  async function resolveConflicts(plan, resolutions, { permissionConfirmed = false } = {}) {
    const needsGrant = (resolutions || []).some((r) => r?.choice === 'keep_taskline');
    if (needsGrant && !permissionConfirmed) return { ok: false, reason: 'permission_required' };
    const result = await resolveHandoffConflicts({ plan, resolutions });
    if (!result.ok) return result;
    const binding = plan.deliveryBinding || {};
    const targetBranch = trim(binding.targetBranch);
    const taskBranch = trim(binding.taskBranch);
    if (result.delivered) {
      return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
        status: 'delivered',
        deliveryMode: 'merge',
        repoId: binding.repoId,
        targetBranch,
        taskBranch,
        commitSha: result.commitSha,
        verdict: 'CONFLICT',
        conflicts: plan.deliveryHandoff?.conflicts,
        resolutions: result.applied,
        updatedAt: now(),
      }) || plan;
    }
    return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
      ...(plan.deliveryHandoff || {}),
      status: 'stopped',
      stoppedReason: 'conflict_resolved',
      resolutions: result.applied,
      updatedAt: now(),
    }) || plan;
  }

  async function previewMerge(plan, resolutions) {
    return previewHandoffMerge({ plan, resolutions });
  }

  async function cleanupPreview(plan, previewPath) {
    const binding = plan?.deliveryBinding || {};
    const repositoryRoot = trim(binding.targetWorkspacePath) || trim(plan?.targetWorkspacePath);
    return cleanupHandoffPreview({ repositoryRoot, previewPath });
  }

  return Object.freeze({
    canHandoff,
    canRecordDirectDelivery,
    recordDirectDelivery,
    lockKey,
    handoffPlan,
    retryHandoff,
    retryHandoffs,
    inspectSource,
    commitSource,
    stashSource,
    resolveConflicts,
    previewMerge,
    cleanupPreview,
  });
}
