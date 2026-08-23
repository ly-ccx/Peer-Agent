import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useState } from 'react';
import {
  DEFAULT_GIT_BRANCH_PREFIX,
  readGitBranchPrefixFromSettings,
  resolveGitBranchPrefix,
} from '../gitBranchPrefix';
import { clientApi } from '../../clientApi';

export interface GitPanelProps {
  readonly i18n: I18nRuntime;
  readonly workspacePath: string | null;
  /** 保存成功后回调通知上层（App），使 gitBranchPrefix 热生效、无需重启。 */
  readonly onGitBranchPrefixChanged?: (value: string) => void;
}

/**
 * GitPanel 是「Git」设置分区的表达层：全局分支前缀 + 当前工作区源头分支。
 *
 * 源头分支写在 workspace settings 上，不是 protocol 字段。切换只影响之后新建的任务线。
 */
export function GitPanel({ i18n, workspacePath, onGitBranchPrefixChanged }: GitPanelProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchPrefix, setBranchPrefix] = useState(() =>
    readGitBranchPrefixFromSettings(clientApi.initialSettings));
  const [savedPrefix, setSavedPrefix] = useState(branchPrefix);
  const [baseBranch, setBaseBranch] = useState('');
  const [savedBaseBranch, setSavedBaseBranch] = useState('');
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [currentHead, setCurrentHead] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!workspacePath) {
      setBaseBranch('');
      setSavedBaseBranch('');
      setBranches([]);
      setCurrentHead(null);
      return;
    }

    void Promise.all([
      clientApi.workspaceList(),
      clientApi.gitListBranches({ workspaceRoot: workspacePath }),
    ]).then(([directory, git]) => {
      if (cancelled) return;
      const workspace = directory.workspaces.find((item) => item.path === workspacePath);
      const saved = workspace?.baseBranch?.trim() || '';
      setBaseBranch(saved);
      setSavedBaseBranch(saved);
      const listed = git.ok ? git.branches : [];
      const next = [...listed];
      if (saved && !next.includes(saved)) next.unshift(saved);
      if (git.current && !next.includes(git.current)) next.unshift(git.current);
      setBranches(next);
      setCurrentHead(git.current);
    }, (err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  async function handleSavePrefix() {
    const next = resolveGitBranchPrefix(branchPrefix);
    if (next === savedPrefix || isSaving) {
      if (next !== branchPrefix) setBranchPrefix(next);
      return;
    }

    const previous = savedPrefix;
    setBranchPrefix(next);
    setSavedPrefix(next);
    setIsSaving(true);
    setError(null);
    try {
      await clientApi.updateSettings({ gitBranchPrefix: next });
      onGitBranchPrefixChanged?.(next);
    } catch (err) {
      setBranchPrefix(previous);
      setSavedPrefix(previous);
      setError(err instanceof Error ? err.message : 'Failed to update branch prefix.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveBaseBranch(next: string) {
    if (!workspacePath || next === savedBaseBranch || isSaving) return;
    const previous = savedBaseBranch;
    setBaseBranch(next);
    setSavedBaseBranch(next);
    setIsSaving(true);
    setError(null);
    try {
      await clientApi.workspaceUpdate({ path: workspacePath, baseBranch: next || null });
    } catch (err) {
      setBaseBranch(previous);
      setSavedBaseBranch(previous);
      setError(err instanceof Error ? err.message : 'Failed to update base branch.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="general-panel">
      <section className="llm-instructions-card general-card">
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('settings.git.baseBranch')}</h3>
            <p>{i18n.t('settings.git.baseBranch.description')}</p>
          </div>
          <div className="general-language-select">
            {workspacePath ? (
              <select
                value={baseBranch}
                disabled={isSaving || branches.length === 0}
                aria-label={i18n.t('settings.git.baseBranch')}
                onChange={(event) => void handleSaveBaseBranch(event.target.value)}
              >
                <option value="">{i18n.t('settings.git.baseBranch.unset')}</option>
                {branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch === currentHead ? `${branch} (HEAD)` : branch}
                  </option>
                ))}
              </select>
            ) : (
              <p className="general-setting-error">{i18n.t('settings.git.baseBranch.empty')}</p>
            )}
          </div>
        </div>
      </section>
      <section className="llm-instructions-card general-card">
        <div className="general-setting-row">
          <div className="general-setting-copy">
            <h3>{i18n.t('settings.git.branchPrefix')}</h3>
            <p>{i18n.t('settings.git.branchPrefix.description')}</p>
          </div>
          <div className="general-language-select">
            <input
              type="text"
              value={branchPrefix}
              spellCheck={false}
              disabled={isSaving}
              placeholder={DEFAULT_GIT_BRANCH_PREFIX}
              aria-label={i18n.t('settings.git.branchPrefix')}
              onChange={(event) => setBranchPrefix(event.target.value)}
              onBlur={() => void handleSavePrefix()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
        </div>
        {error ? <p className="general-setting-error">{error}</p> : null}
      </section>
    </div>
  );
}
