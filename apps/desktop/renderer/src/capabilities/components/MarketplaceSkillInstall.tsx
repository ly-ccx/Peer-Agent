import type { SkillInstallTargetRequest, SkillInstallTargetResult } from '@peer-agent/protocol';
import { useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { ChoiceStrip } from '../../ui/forms/ChoiceStrip';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { MarketplaceWorkspacePicker } from './MarketplaceWorkspacePicker';
import { defaultWorkspaceSelection, describeWorkspaceInstallError, marketplaceInstallLabel } from './marketplace-workspace-target';

type InstallScope = 'global' | 'workspace';
type TargetRequest = Required<SkillInstallTargetRequest>;
const EMPTY_TARGETS = [] as const;

export function MarketplaceSkillInstall({ verb, install, formatError, onPendingChange, onInstalled }: {
  readonly verb: string;
  readonly install: (destination: {
    readonly scope: InstallScope;
    readonly targets?: readonly TargetRequest[];
  }) => Promise<{ readonly ok: boolean; readonly results?: readonly SkillInstallTargetResult[]; readonly error?: string }>;
  readonly formatError: (error: string) => string;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onInstalled: () => void;
}) {
  const reader = useResourceRead('marketplace-install-targets', () => clientApi.listSkillInstallTargets());
  const targets = reader.value ?? EMPTY_TARGETS;
  const [scope, setScope] = useState<InstallScope>('global');
  const [selection, setSelection] = useState<readonly string[] | null>(null);
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<readonly SkillInstallTargetResult[]>([]);
  const [failedRequests, setFailedRequests] = useState<readonly TargetRequest[]>([]);
  const selectedIds = selection ?? defaultWorkspaceSelection(targets);
  const selected = targets.filter((target) => target.available && selectedIds.includes(target.workspaceId));
  const successful = receipts.filter((result) => result.ok);
  const failed = receipts.filter((result) => !result.ok);
  const complete = successful.length > 0 && failed.length === 0
    && selected.every((target) => successful.some((result) => result.workspaceId === target.workspaceId));

  async function submit(installScope: InstallScope, requests: readonly TargetRequest[] = []) {
    if (locked.current || (installScope === 'workspace' && !requests.length)) return;
    locked.current = true;
    setPending(true);
    onPendingChange(true);
    setError(null);
    try {
      const value = await install(installScope === 'workspace' ? { scope: installScope, targets: requests } : { scope: installScope });
      if (installScope === 'global') {
        if (!value.ok) throw new Error(value.error || 'install_failed');
        onInstalled();
      } else {
        if (!value.results?.length) throw new Error(value.error || 'install_failed');
        const results = value.results;
        setReceipts((previous) => [
          ...previous.filter((prior) => !results.some((result) => result.workspaceId === prior.workspaceId)),
          ...results,
        ]);
        setFailedRequests((previous) => [
          ...previous.filter((prior) => !results.some((result) => result.workspaceId === prior.workspaceId)),
          ...requests.filter((request) => results.some((result) => !result.ok && result.workspaceId === request.workspaceId)),
        ]);
        if (!value.ok) void reader.reload();
      }
    } catch (cause) {
      setError(formatError(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      locked.current = false;
      setPending(false);
      onPendingChange(false);
    }
  }

  return (
    <div className="skill-marketplace-install-row" aria-busy={pending}>
      <div className="skill-marketplace-install-actions">
        <span className="skill-marketplace-install-label">安装位置</span>
        <div className="skill-marketplace-install-targets">
          <ChoiceStrip
            className="skill-marketplace-install-scope"
            kind="radio"
            label="安装位置"
            value={scope}
            options={[
              { value: 'global', label: '全局', disabled: pending },
              { value: 'workspace', label: '机器人', disabled: pending },
            ]}
            onChange={(value) => { setScope(value); setError(null); }}
          />
          {scope === 'workspace' && (
            <MarketplaceWorkspacePicker targets={targets} selectedIds={selectedIds} onChange={setSelection} disabled={pending} />
          )}
        </div>
      </div>
      <button
        type="button"
        className="skill-marketplace-install skill-marketplace-install--primary"
        disabled={pending || (scope === 'workspace' && !complete && !selected.length)}
        onClick={() => {
          if (scope === 'workspace' && complete) { onInstalled(); return; }
          void submit(scope, selected.map(({ workspaceId, path }) => ({ workspaceId, workspacePath: path })));
        }}
      >
        {pending ? `正在${verb}` : scope === 'workspace' && complete ? '查看已安装'
          : marketplaceInstallLabel(verb, scope, selected.length)}
      </button>
      {scope === 'workspace' && (
        <>
          {reader.loading && !reader.value && <p className="skill-marketplace-install-note" role="status">正在读取机器人…</p>}
          {reader.error && <div className="skill-marketplace-install-error" role="alert">
            无法读取安装目标
            <button type="button" className="ui-button is-compact" onClick={() => void reader.reload()}>重新读取</button>
          </div>}
          {reader.loaded && !reader.error && !targets.length && (
            <p className="skill-marketplace-install-note" role="status">没有可用的机器人安装目标。</p>
          )}
          {receipts.length > 0 && (
            <div className="skill-marketplace-install-receipt" role="status">
              {successful.length > 0 && (
                <p className="skill-marketplace-install-success">
                  <PeerIcon name="check" size={14} />
                  <span>已安装到 {successful.map((result) => result.name).join('、')}</span>
                </p>
              )}
              {failed.length > 0 && (
                <div className="skill-marketplace-install-error">
                  <p>{successful.length ? '部分安装失败' : '安装失败'}</p>
                  <ul>
                    {failed.map((result) => <li key={result.workspaceId ?? result.path}>
                      <strong>{result.name}</strong> · {describeWorkspaceInstallError(result.error, result.code) ?? formatError(result.error)}
                    </li>)}
                  </ul>
                  {failedRequests.length > 0 && <button type="button" className="ui-button is-compact" disabled={pending}
                    onClick={() => void submit('workspace', failedRequests)}>重试失败项</button>}
                  {successful.length > 0 && <button type="button" className="ui-button is-compact" disabled={pending}
                    onClick={onInstalled}>查看已安装</button>}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {error && <p className="skill-marketplace-install-error" role="alert">{error}</p>}
    </div>
  );
}
