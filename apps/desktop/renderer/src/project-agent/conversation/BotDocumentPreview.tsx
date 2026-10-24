import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotDocumentReference, LocalDocumentReadResult } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { Drawer } from '../../app/components/Drawer';
import { PeerIcon } from '../../ui/icons';
import { useResourceRead } from '../../ui/resources/useResourceState';
import { DocumentPreviewContext } from '../../chat/components/markdown/DocumentPreviewContext';
import { MarkdownDocument } from '../../workbench/file-preview/MarkdownDocument';
import { SourceViewer } from '../../workbench/file-preview/SourceViewer';
import { detectFileKind, highlightLanguageForPath } from '../../workbench/file-preview/fileTypes';
import '../styles/bot-document-preview.css';

function errorLabel(status: LocalDocumentReadResult['status'] | undefined, zh: boolean) {
  const labels = {
    not_found: ['文件不存在，可能已移动或删除。', 'The file was not found. It may have moved or been deleted.'],
    permission_denied: ['没有权限读取此文件。', 'Permission to read this file was denied.'],
    scope_denied: ['此路径超出已确认的项目范围，无法预览。', 'This path is outside the confirmed project scope.'],
    workspace_unavailable: ['项目或知识库位置不可用，无法解析此路径。', 'The project or knowledge repository location is unavailable.'],
    ambiguous_path: ['存在多个同名仓库，请使用明确的文件路径。', 'Several repositories match. Use an unambiguous file path.'],
    not_file: ['此路径是目录，无法作为文档预览。', 'This path is a directory, not a document.'],
    too_large: ['文件过大，无法在此预览。', 'This file is too large to preview.'],
    binary: ['此文件不是可预览的文本文档。', 'This file is not a text document.'],
    invalid_path: ['文件路径无效。', 'The file path is invalid.'],
  };
  const pair = status && status in labels ? labels[status as keyof typeof labels] : ['无法读取文档，请重试。', 'Unable to read the document. Try again.'];
  return pair[zh ? 0 : 1];
}

/** A scoped read-only resource surface; opening never grants the Bot any permission. */
export function BotDocumentPreview({ workspaceId, i18n, children }: {
  readonly workspaceId: string; readonly i18n: I18nRuntime; readonly children: ReactNode;
}) {
  const zh = i18n.locale.startsWith('zh');
  const trigger = useRef<HTMLElement | null>(null);
  const [reference, setReference] = useState<BotDocumentReference | null>(null);
  const [source, setSource] = useState(false);
  const read = useResourceRead(JSON.stringify(reference), () => clientApi.readFile('', undefined, undefined, reference!), Boolean(reference));
  const open = useCallback((path: string, target: HTMLElement) => {
    trigger.current = target; setSource(false); setReference({ workspaceId, path });
  }, [workspaceId]);
  const nestedOpen = useCallback((path: string, _target: HTMLElement) => {
    setSource(false);
    setReference({ workspaceId, path, ...(read.value?.resolvedPath ? { relativeTo: read.value.resolvedPath } : {}) });
  }, [workspaceId, read.value?.resolvedPath]);
  const close = () => setReference(null);
  const ready = read.value?.ok === true;
  const title = zh ? '文档预览' : 'Document preview';
  const adapter = useMemo(() => ({ open, label: title }), [open, title]);
  const nestedAdapter = useMemo(() => ({ open: nestedOpen, label: title }), [nestedOpen, title]);
  const name = read.value?.resolvedPath ?? reference?.path ?? '';
  const markdown = detectFileKind(name) === 'markdown';
  return <DocumentPreviewContext.Provider value={adapter}>
    {children}
    {reference ? <Drawer onClose={close} restoreFocusRef={trigger} ariaLabel={title} panelClassName="bot-document-preview" softBackdrop>
      {({ requestClose }) => <>
        <header className="bot-document-head"><h2>{title}</h2>
          <button type="button" className="ui-button" aria-label={zh ? '关闭预览' : 'Close preview'} onClick={requestClose}><PeerIcon name="close" size={18} /></button>
        </header>
        <p className="bot-document-path">{name}</p>
        <div className="bot-document-actions">
          {ready && markdown ? <>
            <button type="button" className="ui-button" aria-pressed={!source} onClick={() => setSource(false)}>{zh ? '正文' : 'Preview'}</button>
            <button type="button" className="ui-button" aria-pressed={source} onClick={() => setSource(true)}>{zh ? '源码' : 'Source'}</button>
          </> : null}
          <button type="button" className="ui-button" disabled={read.loading} onClick={() => { void read.reload(); }}>{zh ? '重新读取' : 'Read again'}</button>
        </div>
        {read.error && ready ? <p role="alert">{zh ? '重新读取失败，保留上次预览。' : 'The refresh failed. The previous preview is preserved.'}</p> : null}
        <div className="bot-document-body" aria-busy={read.loading}>
          {!read.loaded && !read.error || read.loading && !read.value ? <p role="status">{zh ? '正在读取文档…' : 'Reading document…'}</p> : !ready
            ? <p role="alert">{errorLabel(read.value?.status, zh)}</p>
            : <DocumentPreviewContext.Provider value={nestedAdapter}>
              {markdown && !source ? <MarkdownDocument content={read.value!.content} emptyLabel={zh ? '文档为空。' : 'The document is empty.'}
                copyLabel={zh ? '复制' : 'Copy'} copiedLabel={zh ? '已复制' : 'Copied'} />
                : <SourceViewer content={read.value!.content} emptyLabel={zh ? '文档为空。' : 'The document is empty.'} language={highlightLanguageForPath(name)} />}
            </DocumentPreviewContext.Provider>}
        </div>
      </>}
    </Drawer> : null}
  </DocumentPreviewContext.Provider>;
}
