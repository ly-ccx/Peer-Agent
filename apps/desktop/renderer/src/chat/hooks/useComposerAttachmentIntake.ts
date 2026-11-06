import type React from 'react';
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ChatAttachment } from '../state/types';
import { intakeAttachments } from '../state/attachmentIntake';
import { buildWorkspaceFileAttachment, type WorkspaceFileHit } from '../state/contextMention';
import { buildSessionReferenceAttachment, type SessionReferenceHit } from '../state/sessionReference';
import { loadConversationMessages } from '../state/conversationHydration';

interface AttachmentIntakeOptions {
  readonly attachments: readonly ChatAttachment[];
  readonly setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  readonly setAttachmentError: Dispatch<SetStateAction<string | null>>;
  readonly isZh: boolean;
  readonly hasProvider: boolean;
  readonly isStreaming: boolean;
}

/** Attachment admission and drag state; model context still uses the governed send path. */
export function useComposerAttachmentIntake({ attachments, setAttachments, setAttachmentError, isZh, hasProvider, isStreaming }: AttachmentIntakeOptions) {
  const addFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const result = await intakeAttachments(files, attachments.length, isZh);
    setAttachmentError(result.error);
    if (result.attachments.length) {
      setAttachments((prev) => [...prev, ...result.attachments]);
    }
  }, [attachments.length, isZh]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    setAttachmentError(null);
  }, []);

  const attachWorkspaceFile = useCallback((hit: WorkspaceFileHit) => {
    const attachment = buildWorkspaceFileAttachment(hit);
    setAttachments((prev) => {
      const filtered = prev.filter((item) => item.workspaceRelPath !== attachment.workspaceRelPath);
      return [...filtered, attachment];
    });
  }, []);

  const attachSessionReference = useCallback(async (hit: SessionReferenceHit) => {
    try {
      const loaded = await loadConversationMessages(hit.id);
      const attachment = buildSessionReferenceAttachment({
        conversationId: hit.id,
        title: hit.title,
        messages: loaded.messages,
      });
      setAttachments((prev) => {
        // 同一会话重复引用时替换旧附件，避免叠多份
        const filtered = prev.filter((item) => !item.name.startsWith('session:') || !item.id.includes(hit.id));
        return [...filtered, attachment];
      });
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : (isZh ? '读取会话失败' : 'Failed to load session'));
    }
  }, [isZh]);

  const reorderAttachment = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setAttachments((prev) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileItems = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!fileItems.length) return;
    event.preventDefault();
    void addFiles(fileItems);
  }, [addFiles]);

  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const fileDragDepthRef = useRef(0);
  const canAcceptFileDrop = hasProvider && !isStreaming;
  const hasFileTransfer = useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return false;
    if (Array.from(dataTransfer.types ?? []).includes('Files')) return true;
    return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file');
  }, []);
  const resetFileDropState = useCallback(() => {
    fileDragDepthRef.current = 0;
    setIsFileDropActive(false);
  }, []);
  const handleSurfaceDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDropActive(true);
  }, [canAcceptFileDrop, hasFileTransfer]);
  const handleSurfaceDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDropActive(true);
  }, [canAcceptFileDrop, hasFileTransfer]);
  const handleSurfaceDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setIsFileDropActive(false);
  }, [canAcceptFileDrop, hasFileTransfer]);
  const handleSurfaceDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptFileDrop || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const droppedFiles = event.dataTransfer.files;
    resetFileDropState();
    if (!droppedFiles.length) return;
    void addFiles(droppedFiles);
  }, [addFiles, canAcceptFileDrop, hasFileTransfer, resetFileDropState]);


  return { addFiles, removeAttachment, attachWorkspaceFile, attachSessionReference, reorderAttachment, handlePaste, isFileDropActive, handleSurfaceDragEnter, handleSurfaceDragOver, handleSurfaceDragLeave, handleSurfaceDrop };
}
