import { clientApi } from '../clientApi';
import { useResourceRead } from '../ui/resources/useResourceState';
import { ComparisonRead } from './ResourceChanges';
import { documentReadError } from './ScopedDocumentPage';
import { documentComparisonLabel, type DocumentTabSession } from './documentSessionState';
import { useDocumentReadingPosition } from './useDocumentReadingPosition';

/** A stored comparison describes a read, never an authorization root or a frozen worktree. */
export function ScopedComparisonPage({ tab, workspaceId, active, isZh }: {
  readonly tab: DocumentTabSession; readonly workspaceId: string; readonly active: boolean; readonly isZh: boolean;
}) {
  const reference = { workspaceId, path: tab.reference?.path ?? tab.absPath,
    ...(tab.reference?.relativeTo ? { relativeTo: tab.reference.relativeTo } : {}), kind: 'directory' as const, metadataOnly: true };
  const metadata = useResourceRead(JSON.stringify(reference), () => clientApi.readFile('', undefined, undefined, reference), active);
  const root = metadata.value?.ok && metadata.value.metadataOnly ? metadata.value.resolvedPath : undefined;
  const reading = useDocumentReadingPosition(`${workspaceId}:${tab.id}:${root ?? ''}`, 'comparison', active, !!root);
  return <section className="document-page resource-document" data-active={active} inert={!active} aria-hidden={!active}
    aria-label={tab.comparison ? documentComparisonLabel(tab.comparison, isZh) : 'Diff'}>
    <div ref={reading.ref} onScroll={reading.onScroll} className="resource-document-body" aria-busy={metadata.loading}>
      {!metadata.loaded && !metadata.error ? <p role="status">{isZh ? '正在核对比较来源…' : 'Checking comparison source…'}</p>
        : root && tab.comparison ? <ComparisonRead key={root} workspaceId={workspaceId} path={root} root={root}
          active={active} isZh={isZh} {...tab.comparison} allowKeep={false} />
          : <p role="alert">{metadata.value?.status === 'not_file'
            ? (isZh ? '比较来源已经不是目录，请重新选择。' : 'The comparison source is no longer a directory. Choose another source.')
            : documentReadError(metadata.value?.ok ? 'workspace_unavailable' : metadata.value?.status, isZh)}</p>}
      {root && tab.comparison && !tab.comparison.toRef ? <p className="resource-source-label">{isZh ? '工作树为刷新时的当前内容，可能包含已有本地改动。' : 'The worktree is current at refresh time and may include existing local changes.'}</p> : null}
      {metadata.error ? <p role="alert">{isZh ? '来源刷新未确认，可重试。' : 'The source refresh was not confirmed. Retry.'}</p> : null}
      <button className="ui-button is-compact" type="button" disabled={metadata.loading} onClick={() => void metadata.reload()}>{isZh ? '重新核对来源' : 'Recheck source'}</button>
    </div>
  </section>;
}
