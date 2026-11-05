import { useState } from 'react';
import { useResourceWorkspace } from '../ResourceWorkspaceContext';
export function ResourceLayoutNotice({ isZh }: { readonly isZh: boolean }) {
  const workspace = useResourceWorkspace(), [busy, setBusy] = useState(false);
  const session = workspace?.interactiveLayout, state = workspace?.interactiveLayoutState, error = workspace?.interactiveNotice;
  if (!session || !state || !state.protected && !error || !state.dirty && !error && state.phase !== 'saving') return null;
  const blocked = busy || workspace.interactiveLayoutTransitioning || state.phase === 'loading' || state.phase === 'saving';
  const run = (operation: () => Promise<unknown>) => { setBusy(true); void operation().catch(() => {}).finally(() => setBusy(false)); };
  return <div className="resource-layout-notice" role={error ? 'alert' : 'status'}>
    <p>{error === 'interactive_save_unconfirmed' ? (isZh ? '条件尚未确认保存，当前标签和输入仍保留。请完成输入或在结果中重试保存。' : 'Conditions are not confirmed saved. Your tab and input are preserved. Finish the input or retry saving in the result.')
      : state.phase === 'conflict' ? (isZh ? '其他窗口已更新布局。本地标签和输入仍保留，请选择保留此窗口布局或采用已保存布局。' : 'Another window changed the layout. Your local tabs and input are preserved. Keep this layout or use the saved layout.')
      : error && !state.loaded ? (isZh ? '暂时无法读取已保存的布局，当前视图仍保留。' : 'The saved layout could not be loaded. Your current view is preserved.')
      : error ? (isZh ? '布局尚未确认保存，当前视图仍保留。' : 'The layout is not confirmed saved. Your current view is preserved.')
      : state.phase === 'saving' ? (isZh ? '正在保存布局…' : 'Saving layout…') : (isZh ? '布局更改尚未保存' : 'Layout changes are not saved')}</p>
    {error ? <div><button type="button" className="ui-button is-compact" disabled={blocked} onClick={() => run(() => session.flush())}>{state.loaded ? (isZh ? '重试保存布局' : 'Retry saving layout') : (isZh ? '重试读取布局' : 'Retry loading layout')}</button>
      {state.loaded && (state.phase === 'conflict' || !state.confirmed) ? <button type="button" className="ui-button is-compact" disabled={blocked} onClick={() => run(() => session.keepLocal())}>{isZh ? '保留此窗口布局' : 'Keep this layout'}</button> : null}
      {state.loaded && (state.remote || state.confirmed) ? <button type="button" className="ui-button is-compact" disabled={blocked} onClick={() => run(workspace.useSavedLayout)}>{isZh ? '采用已保存布局' : 'Use saved layout'}</button> : null}</div> : null}
  </div>;
}
