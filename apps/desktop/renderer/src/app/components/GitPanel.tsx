import type { I18nRuntime } from '@peer-agent/i18n';
import { useState } from 'react';
import { clientApi } from '../../clientApi';

const DEFAULT_BRANCH_PREFIX = 'PeerAgent/';

function readBranchPrefix(settings: Record<string, unknown> | null | undefined): string {
  const value = settings?.gitBranchPrefix;
  return typeof value === 'string' && value.trim() ? value : DEFAULT_BRANCH_PREFIX;
}

export interface GitPanelProps {
  readonly i18n: I18nRuntime;
  /** 保存成功后回调通知上层（App），使 gitBranchPrefix 热生效、无需重启。 */
  readonly onGitBranchPrefixChanged?: (value: string) => void;
}

/**
 * GitPanel 是「Git」设置分区的表达层，当前仅提供「分支前缀」一项。
 *
 * 该值持久化到 settings.json 顶层 key gitBranchPrefix，作为 Agent 创建 Git
 * 分支时的名称前缀（默认 PeerAgent/）。复用通用的 clientApi.updateSettings
 * 链路，失焦即保存，保存失败回滚到上一次成功值。
 */
export function GitPanel({ i18n, onGitBranchPrefixChanged }: GitPanelProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchPrefix, setBranchPrefix] = useState(() => readBranchPrefix(clientApi.initialSettings));
  const [savedPrefix, setSavedPrefix] = useState(branchPrefix);

  async function handleSave() {
    const next = branchPrefix.trim() ? branchPrefix : DEFAULT_BRANCH_PREFIX;
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
              placeholder={DEFAULT_BRANCH_PREFIX}
              aria-label={i18n.t('settings.git.branchPrefix')}
              onChange={(event) => setBranchPrefix(event.target.value)}
              onBlur={() => void handleSave()}
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
