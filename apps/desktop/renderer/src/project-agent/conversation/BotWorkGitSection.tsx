import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import type { WorkPanelGitEntry, WorkPanelGitStatus } from '../gitStatusTypes';

type GitStatus = Extract<WorkPanelGitStatus, { kind: 'status' }>;

export function gitBranchLabel(status: GitStatus, i18n: I18nRuntime) {
  if (status.detached) return i18n.t('projectAgent.workPanel.gitDetached', { commit: status.headShort ?? '—' });
  const branch = status.branch ?? '—';
  return status.unborn ? i18n.t('projectAgent.workPanel.gitUnborn', { branch }) : branch;
}

export function gitChangeLabel(status: GitStatus, i18n: I18nRuntime) {
  if (status.changedCount) return i18n.t('projectAgent.workPanel.gitChanged', { count: status.changedCount });
  return i18n.t(status.clean === true ? 'projectAgent.workPanel.gitClean' : 'projectAgent.workPanel.gitUnknown');
}

export function gitEntryLabel(entry: WorkPanelGitEntry, i18n: I18nRuntime) {
  const mark = `${entry.index}${entry.worktree}`;
  return { mark, label: entry.conflicted ? i18n.t('projectAgent.workPanel.gitConflict') : entry.index === '?'
    ? i18n.t('projectAgent.workPanel.gitUntracked') : i18n.t('projectAgent.workPanel.gitXY', { status: mark }) };
}

export function BotWorkGitSection({ status, loading, error, reload, i18n, onOpen }: {
  status?: GitStatus; loading: boolean; error: boolean; reload: () => void; i18n: I18nRuntime; onOpen?: (path: string, kind: 'file' | 'directory') => void;
}) {
  if (!status) return null;
  const branch = gitBranchLabel(status, i18n);
  const refreshLabel = i18n.t('projectAgent.workPanel.gitRefresh');
  return <div className="bot-work-panel-git" aria-busy={loading}>
    <details>
      <summary><PeerIcon name="chevronRight" size={12} /><span className="bot-work-panel-git-summary">
        {i18n.t('projectAgent.workPanel.git')}<bdi title={branch}>{branch}</bdi>
        <span>{error ? i18n.t('projectAgent.workPanel.gitUnknown') : gitChangeLabel(status, i18n)}</span>
      </span></summary>
      <div className="bot-work-panel-git-body">
        <bdi className="bot-work-panel-git-root" title={status.repoRoot}>{status.repoRoot}</bdi>
        <p>{i18n.t('projectAgent.workPanel.gitCounts', { staged: status.stagedCount, unstaged: status.unstagedCount, untracked: status.untrackedCount })}</p>
        {error ? <p role="status">{i18n.t('projectAgent.workPanel.gitUnavailable')}</p> : null}
        {status.truncated ? <p>{i18n.t('projectAgent.workPanel.gitTruncated', { shown: status.entries.length, total: status.totalEntries })}</p> : null}
        {status.entries.length ? <ul className="bot-work-panel-git-entries">{status.entries.map(entry => {
          const { mark, label } = gitEntryLabel(entry, i18n);
          const body = <><code title={label} aria-label={label}>{mark}</code><bdi>{entry.path}</bdi></>;
          const path = entry.openPath;
          return <li key={entry.path}>{path && onOpen && !error
            ? <button type="button" className="bot-work-panel-material" onClick={() => onOpen(path, 'file')}>{body}</button>
            : <span>{body}</span>}</li>;
        })}</ul> : null}
        <p>{i18n.t('projectAgent.workPanel.gitScope')}</p>
        {onOpen ? <button type="button" className="ui-button is-compact" onClick={() => onOpen('.', 'directory')}>
          {i18n.t('projectAgent.workPanel.gitOpenRoot')}</button> : null}
      </div>
    </details>
    {/* A sibling of the disclosure, so activation never toggles it. */}
    <button type="button" className="ui-button is-icon bot-work-panel-git-refresh" title={refreshLabel}
      aria-label={refreshLabel} disabled={loading} onClick={event => { event.stopPropagation(); reload(); }}><PeerIcon name="repeat" size={14} /></button>
  </div>;
}
