import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
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
 * GitPanel 是「Git」设置分区的表达层：全局分支前缀。
 *
 * ADR 79：预配置基准分支（源头分支）已移除——交付绑定跟随工作区实时 HEAD，
 * 无需任何设置项。
 */
export function GitPanel({ i18n, workspacePath, onGitBranchPrefixChanged }: GitPanelProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchPrefix, setBranchPrefix] = useState(() =>
    readGitBranchPrefixFromSettings(clientApi.initialSettings));
  const [savedPrefix, setSavedPrefix] = useState(branchPrefix);

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

  return (
    <div className="general-panel">
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
