import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { resolveSelectionSource } from './markdown/selectionSource';
import './SelectionQuoteAction.css';
import { createSelectionRequestGate } from '../state/selectionRequest';
import { clientApi } from '../../clientApi';
import type { SelectionRange, SelectionReference } from '@peer-agent/protocol';

/** Resolve only a canonical plain-text body. Never guess offsets in rendered Markdown. */
export function SelectionQuoteAction({ root, conversationId, onQuote, onOpenChild }: {
  root: RefObject<HTMLDivElement | null>;
  conversationId: string | null;
  onQuote: (reference: SelectionReference) => void;
  onOpenChild?: (payload: { selection: SelectionRange; reference: SelectionReference; requestId: string }) => void;
}) {
  const [range, setRange] = useState<{ messageId: string; text: string; start: number; end: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ conversationId: string; selection: SelectionRange; requestId: string } | null>(null);
  const gate = useRef(createSelectionRequestGate()).current;
  const toolbar = useRef<HTMLDivElement>(null);
  const selectedRange = useRef<Range | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!range) { setPosition(null); return; }
    const dismiss = () => {
      gate.invalidate();
      setConfirmation(null);
      setRange(null);
      setPosition(null);
      setBusy(false);
    };
    const place = () => {
      const rect = selectedRange.current?.getClientRects()[0];
      const bounds = root.current?.getBoundingClientRect();
      const panel = toolbar.current;
      if (!rect || !bounds || !panel || rect.bottom < Math.max(0, bounds.top)
        || rect.top > Math.min(window.innerHeight, bounds.bottom)) { dismiss(); return; }
      const { width, height } = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
      const above = rect.top - height - 8;
      const top = Math.max(8, Math.min(above >= 8 ? above : rect.bottom + 8, window.innerHeight - height - 8));
      setPosition({ left, top });
    };
    const pointerdown = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) dismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !event.shiftKey && !toolbar.current?.contains(document.activeElement)) {
        event.preventDefault();
        toolbar.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        window.getSelection()?.removeAllRanges();
        dismiss();
      }
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointerdown, true);
    const observer = new ResizeObserver(place);
    if (toolbar.current) observer.observe(toolbar.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('pointerdown', pointerdown, true);
    };
  }, [range, root, gate]);
  useLayoutEffect(() => {
    gate.invalidate();
    setConfirmation(null);
    setBusy(false);
    return () => gate.invalidate();
  }, [gate, conversationId]);
  useEffect(() => {
    setRange(null);
    setError('');
    const inspect = () => {
      gate.invalidate();
      setConfirmation(null);
      setBusy(false);
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { setRange(null); return; }
      const selected = selection.getRangeAt(0);
      const element = selected.startContainer.nodeType === Node.ELEMENT_NODE
        ? selected.startContainer as Element : selected.startContainer.parentElement;
      const body = element?.closest('.chat-msg-text, .markdown-content');
      const message = body?.closest<HTMLElement>('[data-msg-id]');
      if (!body || !message || !root.current?.contains(body) || !body.contains(selected.endContainer)) { setRange(null); return; }
      const mapped = resolveSelectionSource(body, selected);
      selectedRange.current = selected.cloneRange();
      setRange({ messageId: message.dataset.msgId!, ...(mapped ?? { text: '', start: 0, end: 0 }) });
      setError(mapped ? '' : '此选区暂时无法精确映射到原文，请选择普通段落或加粗文字。');
    };
    document.addEventListener('selectionchange', inspect);
    return () => document.removeEventListener('selectionchange', inspect);
  }, [root, conversationId, gate]);
  if (!range || !conversationId) return null;
  const act = async (child: boolean) => {
      const request = gate.begin();
      if (!request) return;
      setBusy(true);
      try {
        const source = await clientApi.conversationsGet({ id: conversationId });
        if (!source) throw new Error('来源会话已不存在');
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(range.text));
        if (!request.isCurrent()) return;
        const selection = {
          conversationId, messageId: range.messageId, blockId: 'content' as const, revision: source.contentRevision,
          start: range.start, end: range.end, exactText: range.text.slice(range.start, range.end),
          sourceTextHash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
        };
        if (child) {
          // 打开侧栏只准备草稿：先校验引用，真正发送时才创建持久子会话。
          const reference = await clientApi.selectionQuote({ conversationId, selection });
          if (!request.isCurrent()) return;
          onOpenChild?.({ selection, reference, requestId: crypto.randomUUID() });
        } else {
          const reference = await clientApi.selectionQuote({ conversationId, selection });
          if (!request.isCurrent()) return;
          onQuote(reference);
        }
        setRange(null);
      } catch (cause) {
        if (request.isCurrent()) setError(cause instanceof Error ? cause.message : '引用失败');
      } finally {
        if (request.finish()) setBusy(false);
      }
  };
  // BACKGROUND_CONFIRMATION_REQUIRED 的确认现在推迟到发送时处理，
  // confirmCreate 仍保留给旧流程的兼容入口，但 act(true) 不再触发它。
  const confirmCreate = async () => {
    if (!confirmation || confirmation.conversationId !== conversationId) return;
    const request = gate.begin();
    if (!request) return;
    setBusy(true);
    try {
      // 确认后仍然只准备草稿，不创建持久子会话
      const reference = await clientApi.selectionQuote({ conversationId: confirmation.conversationId, selection: confirmation.selection });
      if (!request.isCurrent()) return;
      onOpenChild?.({ selection: confirmation.selection, reference, requestId: confirmation.requestId });
      setConfirmation(null);
      window.getSelection()?.removeAllRanges();
      setRange(null);
    } catch (cause) {
      if (request.isCurrent()) {
        setConfirmation(null);
        setError(cause instanceof Error ? cause.message : '准备失败，请重新选择原文。');
      }
    } finally { if (request.finish()) setBusy(false); }
  };
  return createPortal(<div ref={toolbar} className="selection-action-toolbar" role="group" aria-label="选区操作"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}>
    {confirmation ? <div className="selection-action-toolbar__confirm">
      <span role="alert">背景不完整：部分附件或工具材料尚未解析，不会作为完整材料继承。仍要使用可用背景创建子会话吗？</span>
      <div className="selection-action-toolbar__actions">
        <button type="button" disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => { setConfirmation(null); setError(''); }}>取消</button>
        <button type="button" disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => void confirmCreate()}>仍然创建</button>
      </div>
    </div> : <>
    <button type="button" disabled={busy || range.end <= range.start} onMouseDown={(event) => event.preventDefault()} onClick={() => void act(false)}>添加到对话</button>
    {onOpenChild ? <button type="button" disabled={busy || range.end <= range.start} onMouseDown={(event) => event.preventDefault()} onClick={() => void act(true)}>在侧栏打开</button> : null}
    </>}
    {error ? <span role="alert">{error}</span> : null}
  </div>, document.body);
}
