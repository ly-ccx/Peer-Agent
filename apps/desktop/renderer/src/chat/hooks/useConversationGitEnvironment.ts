import { useCallback, useMemo, useState } from 'react';
import { clientApi } from '../../clientApi';
import type { DropdownOption } from '../../app/components/Dropdown';
import type { CreateBranchRequest } from '../components/CreateBranchDialog';
import { useWorkspaceGit } from './useWorkspaceGit';
import {
  COMPOSER_ENV_ISOLATION_OFF, COMPOSER_ENV_ISOLATION_ON, buildComposerBranchOptions,
  formatComposerBranchOptionLabel, formatComposerEnvCapsule, isComposerEnvSentinel,
  isSafeComposerBranchName, parseComposerUpstreamSpec, planComposerGitChrome,
  resolveComposerCreateSourceBranch, type TaskDeliveryLine,
} from '../state/taskBoundBranch';

interface GitEnvironmentOptions {
  readonly workspacePath: string | null;
  readonly conversationId: string | null;
  readonly isStreaming: boolean;
  readonly isZh: boolean;
  readonly preferredWorktree: boolean;
  readonly changePreferredWorktree: (enabled: boolean) => void;
}

/** Owns task-bound Git presentation and branch dialog actions; execution stays in the host. */
export function useConversationGitEnvironment({ workspacePath, conversationId, isStreaming, isZh, preferredWorktree, changePreferredWorktree }: GitEnvironmentOptions) {
  const isDraftConversation = conversationId === null;
  const { workspaceGit, workspaceIsGit, refreshWorkspaceGit } = useWorkspaceGit(workspacePath, {
    refreshWhenIdle: !isStreaming,
  });
  const [createBranchDialog, setCreateBranchDialog] = useState<{
    readonly source: string;
  } | null>(null);
  const [branchPushNotice, setBranchPushNotice] = useState<{
    readonly branchName: string;
    readonly reason: string;
  } | null>(null);
  const [deliveryLine, setDeliveryLine] = useState<TaskDeliveryLine | null>(null);
  const [deliveryLineKnown, setDeliveryLineKnown] = useState(false);
  const handleActiveDeliveryChange = useCallback((line: TaskDeliveryLine | null) => {
    setDeliveryLine(line);
    setDeliveryLineKnown(true);
  }, []);
  // ADR 79：预配置源头（workspace baseBranch）已移除。draft 的「源头」芯片直接
  // 跟随工作区实时 HEAD（planComposerGitChrome 内部回退 currentHead）。
  const gitChrome = useMemo(
    () => planComposerGitChrome({
      delivery: deliveryLine,
      workspaceBaseBranch: null,
      currentHead: workspaceGit?.ok ? workspaceGit.current : null,
      isDraft: isDraftConversation,
      deliveryKnown: isDraftConversation || deliveryLineKnown,
    }, { locale: isZh ? 'zh' : 'en' }),
    [deliveryLine, deliveryLineKnown, isDraftConversation, isZh, workspaceGit],
  );
  // ADR 79：composer 不再提供「固定源头分支」选择（无设置可写）；
  // 隔离偏好（Worktree on/off）不受影响。
  const canSelectBoundBranch = false;
  const envCapsule = useMemo(
    () => formatComposerEnvCapsule(gitChrome, {
      locale: isZh ? 'zh' : 'en',
      preferredIsolation: preferredWorktree,
    }),
    [gitChrome, isZh, preferredWorktree],
  );
  /**
   * Forkable branches only — no isolation sentinels, and not gated on the capsule's
   * `selectable` flag, because the create-branch dialog needs a pickable list even when
   * the capsule itself is not offering branch switching.
   */
  const composerBranchOptions = useMemo<readonly DropdownOption[]>(() => {
    const localGroup = isZh ? '源头' : 'Source';
    const remoteGroup = isZh ? '远程源头' : 'Remote source';
    return buildComposerBranchOptions({
      branches: workspaceGit?.ok ? workspaceGit.branches : [],
      localBranches: workspaceGit?.ok ? workspaceGit.localBranches : [],
      remoteBranches: workspaceGit?.ok ? workspaceGit.remoteBranches : [],
      selected: gitChrome.taskLine?.value,
    }).map((option) => ({
      value: option.value,
      label: formatComposerBranchOptionLabel(option.value),
      group: option.kind === 'remote' ? remoteGroup : localGroup,
      tab: option.kind,
      hint: option.kind === 'remote'
        ? (isZh ? '远程' : 'remote')
        : (isZh ? '本地' : 'local'),
    }));
  }, [gitChrome.taskLine?.value, isZh, workspaceGit]);
  const handleSelectBoundBranch = useCallback((nextBranch: string) => {
    const next = nextBranch.trim();
    if (next === COMPOSER_ENV_ISOLATION_ON) {
      if (!isStreaming) changePreferredWorktree(true);
      return;
    }
    if (next === COMPOSER_ENV_ISOLATION_OFF) {
      if (!isStreaming) changePreferredWorktree(false);
      return;
    }
    // ADR 79：分支选择不再写工作区设置（预配置源头已移除），此路径不生效。
  }, [changePreferredWorktree, isStreaming]);
  const handleCreateBoundBranch = useCallback((request: CreateBranchRequest) => {
    const name = request.name.trim();
    if (!name || !workspacePath || !canSelectBoundBranch) return;
    if (!isSafeComposerBranchName(name)) return;
    // The dialog owns the source choice; re-check here so a sentinel ("Worktree" row) can
    // never reach git even if a caller constructs the request by hand.
    const source = request.source.trim();
    if (!source || isComposerEnvSentinel(source)) return;
    const shouldPush = request.push;
    const upstream = shouldPush ? parseComposerUpstreamSpec(request.upstream, name) : null;
    if (shouldPush && !upstream) return;
    void clientApi.gitCreateBranch({
      workspaceRoot: workspacePath,
      name,
      startPoint: source,
      push: shouldPush,
      upstreamRemote: upstream?.remote,
      upstreamBranch: upstream?.branch,
    }).then((created) => {
      if (created?.ok !== true) return;
      if (shouldPush && created.pushed === false) {
        setBranchPushNotice({
          branchName: name,
          reason: created.pushError || 'push_failed',
        });
      } else {
        setBranchPushNotice(null);
      }
      handleSelectBoundBranch(name);
      refreshWorkspaceGit();
    }).catch(() => {});
  }, [
    canSelectBoundBranch,
    handleSelectBoundBranch,
    refreshWorkspaceGit,
    workspacePath,
  ]);
  /**
   * Opens the create-branch dialog. Takes no branch argument on purpose: the capsule list
   * highlight follows the mouse, so the source must be chosen inside the dialog instead.
   * The dialog only needs a sensible default seed, which is the checked branch or HEAD.
   */
  const handleOpenCreateBranchDialog = useCallback(() => {
    if (!canSelectBoundBranch) return;
    const source = resolveComposerCreateSourceBranch({
      selected: gitChrome.taskLine?.value,
      currentHead: workspaceGit?.current,
    });
    if (!source) return;
    setCreateBranchDialog({ source });
  }, [canSelectBoundBranch, gitChrome.taskLine?.value, workspaceGit?.current]);
  const resetDeliveryContext = useCallback(() => { setDeliveryLine(null); setDeliveryLineKnown(false); }, []);
  const closeCreateBranchDialog = useCallback(() => setCreateBranchDialog(null), []);
  const dismissBranchPushNotice = useCallback(() => setBranchPushNotice(null), []);
  return { deliveryLine, deliveryLineKnown, workspaceGit, workspaceIsGit, refreshWorkspaceGit, createBranchDialog, branchPushNotice, handleActiveDeliveryChange, gitChrome, canSelectBoundBranch, envCapsule, composerBranchOptions, handleSelectBoundBranch, handleCreateBoundBranch, handleOpenCreateBranchDialog, resetDeliveryContext, closeCreateBranchDialog, dismissBranchPushNotice };
}
