import { useState } from 'react';
import type { BotDocumentReference, ConfirmedGitDocumentRevision } from '@peer-agent/protocol';
import { MotionDetails } from '../app/components/MotionDetails';
import { isImeKey } from '../chat/state/compositionGuard';
import { useResourceWorkspace } from './ResourceWorkspaceContext';
import { normalizeDocumentRevision } from './documentRevisionState';
import { PeerIcon } from '../ui/icons';

export function DocumentHistoryTools({ reference, path, confirmed, isZh, hidden = false }: {
  readonly reference: BotDocumentReference; readonly path: string;
  readonly confirmed?: ConfirmedGitDocumentRevision; readonly isZh: boolean;
  readonly hidden?: boolean;
}) {
  const workspace = useResourceWorkspace();
  const [commit, setCommit] = useState('');
  const revision = reference.revision;
  if (revision) return <div className="resource-changes-toolbar" hidden={hidden} inert={hidden} style={hidden ? { display: 'none' } : undefined}>
    <span className="resource-source-label">{isZh ? '历史提交：' : 'Historical commit: '}{confirmed?.commit ?? revision.commit}</span>
    <button type="button" className="ui-button is-compact" onClick={() => workspace?.openReference({ workspaceId: reference.workspaceId,
      path, ...(reference.task ? { task: reference.task } : {}), ...(!confirmed && reference.relativeTo ? { relativeTo: reference.relativeTo } : {}) })}>
      {isZh ? '打开当前文件' : 'Open current file'}</button>
  </div>;
  const requested = normalizeDocumentRevision({ kind: 'git', commit: commit.trim() });
  return <MotionDetails className="resource-document-history" hidden={hidden} inert={hidden} style={hidden ? { display: 'none' } : undefined}>
    <summary><PeerIcon name="chevronRight" size={14} />{isZh ? '查看历史版本' : 'Read a historical version'}</summary>
    <form className="resource-range" onSubmit={event => { event.preventDefault(); if (requested) workspace?.openReference({
      workspaceId: reference.workspaceId, path, ...(reference.task ? { task: reference.task } : {}),
      ...(reference.relativeTo ? { relativeTo: reference.relativeTo } : {}), revision: requested,
    }); }}>
      <label className="resource-source-label">{isZh ? '完整提交 SHA' : 'Full commit SHA'}
        <input value={commit} onChange={event => setCommit(event.target.value)} maxLength={128}
          aria-label={isZh ? '完整提交 SHA' : 'Full commit SHA'} autoComplete="off" spellCheck={false}
          onKeyDown={event => { if (event.key === 'Enter' && isImeKey(event.nativeEvent)) event.preventDefault(); }} />
      </label>
      <button type="submit" className="ui-button is-compact" disabled={!requested}>{isZh ? '打开历史版本' : 'Open historical version'}</button>
    </form>
  </MotionDetails>;
}
