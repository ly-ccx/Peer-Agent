import { PeerIcon } from '../../ui/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ResourceEditSource } from '@peer-agent/protocol';
import { useConfirm } from '../../app/components/ConfirmProvider';
import { createCompositionGuard } from '../../chat/state/compositionGuard';
import { LocalDocumentRenderingContext } from '../../chat/components/markdown/DocumentPreviewContext';
import { SourceViewer } from '../file-preview/SourceViewer';
import { MarkdownDocument } from '../file-preview/MarkdownDocument';
import { detectFileKind, highlightLanguageForPath } from '../file-preview/fileTypes';
import { resourceEditRegistry } from './resourceEditRegistry';
import type { ResourceEditSession } from './resourceEditSession';
import { resourceEditMessage } from './resourceEditMessages';
import { readEditCurrent } from './readEditCurrent';
import { textInputEdit, textareaText } from './textInputEdit';
import { ResourceDraftLibrary } from './ResourceDraftLibrary';
import { ResourceSubmissionControl } from './ResourceSubmissionControl';
import './resource-editing.css';

type EditorMode = 'edit' | 'preview' | 'compare';
export function ResourceEditor({ session, active, isZh, source, onNewBase, onDiscarded, onReturn }: {
  readonly session: ResourceEditSession; readonly active: boolean; readonly isZh: boolean; readonly source?: ResourceEditSource;
  readonly onNewBase: (session: ResourceEditSession) => void; readonly onDiscarded?: () => void; readonly onReturn?: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot), confirm = useConfirm();
  const [mode, setMode] = useState<EditorMode>('edit');
  const identity = JSON.stringify([session.workspaceId, session.draftId, source]), identityRef = useRef(identity); identityRef.current = identity;
  const readEpoch = useRef(0);
  const handleIdentity = JSON.stringify(state.view?.handle);
  const [captured, setCaptured] = useState<{ identity: string; value: Awaited<ReturnType<typeof readEditCurrent>> } | null>(null), [reading, setReading] = useState(false);
  const current = captured?.identity === identity ? captured.value : null;
  const [notice, setNotice] = useState<string | null>(null), [action, setAction] = useState(false);
  const readBody = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null), live = useRef(active); live.current = active;
  const guard = useMemo(createCompositionGuard, [session]);
  useEffect(() => { readEpoch.current++; setReading(false); return () => { readEpoch.current++; }; }, [session, active, identity, handleIdentity]);
  useEffect(() => {
    live.current = active;
    const registry = resourceEditRegistry(); if (!registry) return;
    const detach = registry.attach(session);
    return () => { live.current = false; guard.reset(); detach(); };
  }, [session, guard]);
  useEffect(() => { if (active) void session.connect(); }, [session, active]);
  useLayoutEffect(() => {
    if (!active) return;
    if (mode !== 'edit') { const point = session.snapshot().reading[mode], node = readBody.current; if (point && node) { node.scrollTop = point.top; node.scrollLeft = point.left; } return; }
    if (!input.current) return;
    const point = session.snapshot().cursor, element = input.current;
    element.setSelectionRange(point.start, point.end); element.scrollTop = point.top; element.scrollLeft = point.left;
  }, [session, active, mode]);
  const remember = () => {
    const element = input.current;
    if (element) session.remember({ start: element.selectionStart, end: element.selectionEnd, top: element.scrollTop, left: element.scrollLeft });
  };
  const rememberReading = () => { const node = readBody.current; if (node && mode !== 'edit') session.rememberReading(mode, { top: node.scrollTop, left: node.scrollLeft }); };
  const path = state.baseline?.target.reference.path ?? session.expectedPath ?? '', language = highlightLanguageForPath(path);
  const modes: readonly EditorMode[] = detectFileKind(path) === 'markdown' ? ['edit', 'preview', 'compare'] : ['edit', 'compare'];
  const compare = async () => {
    if (reading || !state.view) return; const ticket = ++readEpoch.current, handle = JSON.stringify(state.view.handle); setMode('compare'); setReading(true); setNotice(null);
    const valid = () => live.current && identityRef.current === identity && readEpoch.current === ticket && JSON.stringify(session.snapshot().view?.handle) === handle;
    try { const value = await readEditCurrent(state.view.draft.target, source); if (valid()) setCaptured({ identity, value }); }
    catch { if (valid()) setNotice(isZh ? '当前文件暂不可读或身份已变化，旧基础和草稿保留。' : 'The current file is unavailable or changed identity. The base and draft are preserved.'); }
    finally { if (valid()) setReading(false); }
  };
  const newBase = async () => {
    if (!current || action || !state.view) return; setAction(true);
    try {
      if (!await session.flush() || !live.current || identityRef.current !== identity) return;
      const registry = resourceEditRegistry(), next = await registry?.openSource(current.source);
      if (next && live.current && identityRef.current === identity) onNewBase(next);
      else if (!next && live.current && identityRef.current === identity) setNotice(resourceEditMessage(registry?.error() ?? 'RESOURCE_EDIT_SOURCE_UNAVAILABLE', isZh));
      else if (next && next !== session && !registry?.list().some(entry => entry.session === next && entry.uses > 0)) void next.close();
    } finally { setAction(false); }
  };
  const destructive = async (discard: boolean) => {
    if (action || state.composing) return; setAction(true);
    try {
      if (!await confirm({ title: discard ? (isZh ? '删除本机草稿？' : 'Delete local draft?') : (isZh ? '放弃当前未保存输入？' : 'Replace unsaved input?'),
        message: discard ? (isZh ? '仅删除这份本机草稿，原文件和执行依据保留。' : 'Only this local draft is deleted. The original file and evidence remain.')
          : (isZh ? '当前输入将被已保存的草稿替换。' : 'Your current input will be replaced with the saved draft.'), tone: 'danger',
        confirmText: isZh ? '确认' : 'Confirm', cancelText: isZh ? '保留' : 'Keep' }) || !live.current || identityRef.current !== identity) return;
      if (discard) { if (await session.discard() && !session.snapshot().dirty && live.current && identityRef.current === identity) onDiscarded?.(); } else session.useSavedText();
    } finally { setAction(false); }
  };
  return <section className="resource-editor" aria-label={isZh ? '本机草稿编辑器' : 'Local draft editor'} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
    <header className="resource-editor-toolbar">
      <span className="resource-editor-name" title={path}>{path.split(/[\\/]/).pop() || (isZh ? '本机草稿' : 'Local draft')}</span>
      <span className="resource-source-label">{isZh ? '本机草稿' : 'Local draft'}</span>
      <span className="resource-editor-status" role="status">{state.saving ? (isZh ? '保存草稿中…' : 'Saving draft…') : state.dirty ? (isZh ? '有未保存输入' : 'Unsaved input') : state.view ? (isZh ? '草稿已保存' : 'Draft saved') : ''}</span>
      {onReturn ? <button className="ui-button is-compact" disabled={state.composing || action} onClick={async () => { if (await session.flush() && live.current && identityRef.current === identity) onReturn(); }}>{isZh ? '返回阅读' : 'Return to reading'}</button> : null}
    </header>
    <div className="resource-editor-toolbar" role="group" aria-label={isZh ? '草稿模式' : 'Draft mode'}>
      {modes.map(value => <button key={value} type="button" className="ui-button is-compact" disabled={state.composing} aria-pressed={mode === value} onClick={() => { remember(); setMode(value); }}>{value === 'edit' ? (isZh ? '编辑' : 'Edit') : value === 'preview' ? (isZh ? '正文' : 'Preview') : (isZh ? '比较' : 'Compare')}</button>)}
      {!state.writer ? <button className="ui-button is-compact" disabled={state.loading || action} onClick={() => void session.claim(state.error?.includes('WRITER_BUSY'))}>{state.error?.includes('WRITER_BUSY') ? (isZh ? '接管编辑' : 'Take over editing') : (isZh ? '取得编辑权' : 'Edit this draft')}</button> : null}
      <button className="ui-button is-compact" disabled={!state.writer || state.composing || state.saving || state.reviewRequired} onClick={() => void session.flush()}>{isZh ? '保存草稿' : 'Save draft'}</button>
      <button className="ui-button is-compact" disabled={state.loading || state.composing || state.saving} onClick={() => void session.readSaved()}>{isZh ? '重读已保存草稿' : 'Read saved draft'}</button>
      <button className="ui-button is-compact" disabled={!state.writer || action || state.composing || state.saving} onClick={() => void destructive(true)}>{isZh ? '删除草稿' : 'Delete draft'}</button>
    </div>
    {state.loading ? <p className="resource-source-label" role="status">{isZh ? '正在打开本机草稿…' : 'Opening local draft…'}</p> : null}
    {state.error ? <div className="resource-editor-notice" role="alert">{resourceEditMessage(state.error, isZh)}<details><summary><PeerIcon name="chevronRight" size={12} />{isZh ? '详情' : 'Details'}</summary>{state.error}</details></div> : null}
    {state.remoteChanged || state.reviewRequired ? <div className="resource-editor-notice" role="status">
      <span>{isZh ? '另一处已保存的内容发生变化。请先重读并比较。' : 'Saved content changed elsewhere. Read it and compare first.'}</span>
      {state.reviewRequired ? <><button className="ui-button is-compact" disabled={!state.writer || state.composing || action} onClick={() => void session.confirmBufferedSave()}>{isZh ? '以我的输入保存草稿' : 'Save my buffered text'}</button>
        <button className="ui-button is-compact" disabled={state.composing || action} onClick={() => void destructive(false)}>{isZh ? '采用已保存草稿' : 'Use saved draft'}</button></> : null}
    </div> : null}
    {notice ? <p className="resource-editor-notice" role="status">{notice}</p> : null}
    {mode === 'edit' ? <textarea ref={input} className="resource-editor-input" value={textareaText(state.text)} readOnly={!state.writer} spellCheck={false}
      aria-label={isZh ? '草稿原文' : 'Draft source text'} onChange={event => { session.edit(textInputEdit(session.snapshot().text, event.target.value)); remember(); }} onSelect={remember} onScroll={remember}
      onCompositionStart={event => { guard.start(event.currentTarget); session.setComposing(true); }}
      onCompositionEnd={event => { guard.end(event.currentTarget); session.edit(textInputEdit(session.snapshot().text, event.currentTarget.value)); session.setComposing(false); remember(); }}
      onKeyUp={event => guard.keyUp(event.nativeEvent)} onKeyDown={event => {
        if (guard.keyDown(event.nativeEvent)) { event.stopPropagation(); return; }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void session.flush(); }
        if (event.key === 'Escape') event.stopPropagation();
      }} />
      : mode === 'preview' ? <div ref={readBody} onScroll={rememberReading} className="resource-editor-reading"><LocalDocumentRenderingContext.Provider value={true}><MarkdownDocument isZh={isZh} content={state.text} emptyLabel={isZh ? '草稿为空。' : 'Empty draft.'} copyLabel={isZh ? '复制' : 'Copy'} copiedLabel={isZh ? '已复制' : 'Copied'} /></LocalDocumentRenderingContext.Provider></div>
        : <div ref={readBody} onScroll={rememberReading} className="resource-editor-reading">
          <div className="resource-editor-toolbar"><button className="ui-button is-compact" disabled={reading || !state.view} onClick={() => void compare()}>{reading ? (isZh ? '读取当前文件中…' : 'Reading current file…') : (isZh ? '读取当前文件比较' : 'Read current file to compare')}</button>
            {current && current.source.observed.contentVersion !== state.view?.draft.target.base.contentVersion ? <button className="ui-button is-compact" disabled={action || state.composing} onClick={() => void newBase()}>{isZh ? '以当前文件另建草稿' : 'Create separate draft from current file'}</button> : null}</div>
          <div className="resource-editor-comparison">
            <section><h2>{isZh ? '原基础' : 'Original base'}</h2><SourceViewer isZh={isZh} content={state.baseline?.baseText ?? ''} language={language} emptyLabel={isZh ? '基础为空。' : 'Empty base.'} /></section>
            <section><h2>{isZh ? '我的草稿' : 'My draft'}</h2><SourceViewer isZh={isZh} content={state.text} language={language} emptyLabel={isZh ? '草稿为空。' : 'Empty draft.'} /></section>
            {state.reviewRequired ? <section><h2>{isZh ? '已保存草稿' : 'Saved draft'}</h2><SourceViewer isZh={isZh} content={state.savedText} language={language} emptyLabel={isZh ? '草稿为空。' : 'Empty draft.'} /></section> : null}
            {current ? <section><h2>{isZh ? '明确读取的当前文件' : 'Explicitly read current file'}</h2><SourceViewer isZh={isZh} content={current.text} language={language} emptyLabel={isZh ? '文件为空。' : 'Empty file.'} /></section> : null}
          </div>
          {state.view ? <ResourceDraftLibrary key={state.view.handle.viewId} scope={{ workspaceId: session.workspaceId, handle: state.view.handle }} active={active} isZh={isZh} onOpen={draft => {
            const value = resourceEditRegistry()?.get(session.workspaceId, draft.id, { source, expectedPath: draft.target.reference.path }); if (value) onNewBase(value);
          }} /> : null}
        </div>}
    <ResourceSubmissionControl session={session} active={active} isZh={isZh} onCompare={() => void compare()} />
  </section>;
}
