import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { InteractiveResultReference, InteractiveResultsApi, InteractiveViewHandle } from '@peer-agent/protocol';
import { createVersionNavigationSession } from './versionNavigationSession';

export function InteractiveVersions({ reference, handle, api, openReference, isZh }: {
  readonly reference: InteractiveResultReference; readonly handle: InteractiveViewHandle; readonly api: InteractiveResultsApi;
  readonly openReference?: (reference: InteractiveResultReference) => boolean | Promise<boolean>; readonly isZh: boolean;
}) {
  const session = useMemo(() => createVersionNavigationSession({ reference, handle, api, openReference }),
    [reference.owner.workspaceId, reference.owner.conversationId, reference.resultId, reference.contentVersion,
      handle.viewId, handle.windowId, handle.generation, api, openReference]);
  useEffect(() => () => session.dispose(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const busy = ['loading', 'opening'].includes(state.phase), versions = state.versions;
  const newer = versions && versions.head.contentVersion !== reference.contentVersion;
  return <section className="interactive-versions" aria-label={isZh ? '结果版本' : 'Result versions'}>
    <div><button type="button" className="ui-button" disabled={busy} onClick={() => { void session.check(); }}>{isZh ? '检查版本' : 'Check versions'}</button>
      {newer ? <button type="button" className="ui-button" disabled={busy} onClick={() => { void session.open('head'); }}>{isZh ? '打开新版本' : 'Open newer version'}</button> : null}
      {versions?.predecessor ? <button type="button" className="ui-button" disabled={busy} onClick={() => { void session.open('predecessor'); }}>{isZh ? '打开上一版本' : 'Open previous version'}</button> : null}</div>
    {busy ? <p role="status">{state.phase === 'loading' ? (isZh ? '正在核对已发布版本…' : 'Checking published versions…') : (isZh ? '正在打开固定版本，原视图保留…' : 'Opening the fixed version. Your current view is preserved…')}</p>
      : state.error ? <p role="status">{state.error === 'version_conflict' ? (isZh ? '版本关系已变化，请重新检查。当前视图和输入保留。' : 'Versions changed. Check again. Your current view and input are preserved.')
        : (isZh ? '暂时无法核对或打开版本。当前视图和输入保留，可重试检查。' : 'Unable to check or open versions. Your current view and input are preserved; retry checking.')}</p>
      : versions ? <p role="status">{newer ? (isZh ? '有新的已发布版本。当前结果仍固定在原版本。' : 'A newer published version is available. This result remains fixed.')
        : (isZh ? '当前是本次核对的最新发布版本。' : 'This is the latest published version at this check.')}</p> : null}
  </section>;
}
