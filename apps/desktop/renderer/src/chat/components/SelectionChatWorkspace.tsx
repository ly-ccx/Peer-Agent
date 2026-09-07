import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ChatSurface } from './ChatSurface';
import { Drawer } from '../../app/components/Drawer';
import { WorkbenchProvider } from '../../workbench/WorkbenchContext';
import { clientApi } from '../../clientApi';
import { conversationStore } from '../state/conversationStore';
import { loadComposerEntry, saveComposerEntry } from '../state/composerPersistence';
import type { SelectionChildSummary, SelectionRange, SelectionReference } from '@peer-agent/protocol';

/** 未发送的草稿子会话：用本地 id，不落盘，不进左侧列表。 */
type SelectionChildDraft = {
  readonly id: string;
  readonly title: string;
  readonly parentId: string;
  readonly workspacePath: string | null;
  readonly reference: SelectionReference;
  readonly selection: SelectionRange;
  readonly requestId: string;
  readonly persisted: false;
};

/** 已发送的持久子会话。 */
type SelectionChildSession = {
  readonly id: string;
  readonly title: string;
  readonly parentId: string;
  readonly workspacePath: string | null;
  readonly reference: SelectionReference;
  readonly persisted: true;
};

type SelectionChild = SelectionChildDraft | SelectionChildSession;

/** Keep the parent's surface mounted. The child has a distinct runtime bucket. */
export function SelectionChatWorkspace(props: ComponentProps<typeof ChatSurface>) {
  const [children, setChildren] = useState<readonly SelectionChildSummary[]>([]);
  const [child, setChild] = useState<SelectionChild | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingSendText, setPendingSendText] = useState('');
  const pendingSendRef = useRef('');
  const parentRef = useRef(props.conversationId);
  parentRef.current = props.conversationId;
  const openGeneration = useRef(0);
  useEffect(() => () => { openGeneration.current += 1; }, []);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      if (!props.conversationId) { setChildren([]); return; }
      try {
        const page = await clientApi.selectionListChildren({ conversationId: props.conversationId, limit: 100 });
        if (live) setChildren(page.items);
      } catch (cause) { if (live) setError(String(cause)); }
    };
    void refresh();
    const off = clientApi.onConversationsChanged(() => void refresh());
    return () => { live = false; off(); };
  }, [props.conversationId, child?.id]);
  const open = async (id: string) => {
    if (saving || child?.id === id) return;
    const generation = ++openGeneration.current;
    const parentId = props.conversationId;
    try {
      if (child && child.persisted) {
        await clientApi.selectionSaveDraft({ conversationId: child.id,
          text: conversationStore.getSnapshot(child.id).draft, referenceIds: [child.reference.id] });
      }
      const session = await clientApi.conversationsGet({ id });
      if (generation !== openGeneration.current || parentRef.current !== parentId) return;
      if (!session?.selectionOrigin || session.selectionOrigin.parentConversationId !== props.conversationId) throw new Error('子会话不存在或来源已变化');
      if (!loadComposerEntry(id) && session.selectionDraft?.text) {
        saveComposerEntry(id, { draft: session.selectionDraft.text, queue: [] });
      }
      setChild({ id, title: session.title, parentId: session.selectionOrigin.parentConversationId,
        workspacePath: props.workspacePath ?? null, reference: session.selectionOrigin.reference, persisted: true });
      setError('');
    } catch (cause) {
      if (generation === openGeneration.current && parentRef.current === parentId) setError(String(cause));
    }
  };

  /** 打开草稿态：不落盘，不进左侧列表。 */
  const openDraft = (payload: { selection: SelectionRange; reference: SelectionReference; requestId: string }) => {
    if (saving) return;
    openGeneration.current += 1;
    setChild({
      id: `draft-${payload.requestId}`,
      title: payload.reference.exactText.slice(0, 60) || '侧边讨论',
      parentId: props.conversationId!,
      workspacePath: props.workspacePath ?? null,
      reference: payload.reference,
      selection: payload.selection,
      requestId: payload.requestId,
      persisted: false,
    });
    setError('');
  };

  const persistChild = async (confirmMissing = false): Promise<{ conversationId: string } | null> => {
    if (!child || child.persisted) return null;
    const draftId = child.id;
    try {
      const session = await clientApi.selectionCreateChild({
        conversationId: child.parentId,
        selection: child.selection,
        requestId: child.requestId,
        confirmMissing,
      });
      conversationStore.adoptBucket(draftId, session.id);
      setChild({
        id: session.id,
        title: session.title,
        parentId: session.selectionOrigin.parentConversationId,
        workspacePath: child.workspacePath,
        reference: session.selectionOrigin.reference,
        persisted: true,
      });
      setError('');
      props.onConversationUpdated?.();
      try {
        const page = await clientApi.selectionListChildren({ conversationId: child.parentId, limit: 100 });
        setChildren(page.items);
      } catch { /* 列表刷新失败不阻断发送；下次 conversationsChanged 会补上。 */ }
      return { conversationId: session.id };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as { code?: unknown }).code ?? '')
        : '';
      if (message.includes('BACKGROUND_CONFIRMATION_REQUIRED') || code === 'BACKGROUND_CONFIRMATION_REQUIRED') {
        setError('BACKGROUND_CONFIRMATION_REQUIRED');
        return null;
      }
      setError(`创建子会话失败：${message}`);
      return null;
    }
  };

  /** 草稿首次发送：创建持久子会话，返回真实 conversationId。 */
  const createChildOnSend = async (): Promise<{ conversationId: string } | null> => {
    if (!child || child.persisted) return null;
    pendingSendRef.current = conversationStore.getSnapshot(child.id).draft;
    return persistChild(false);
  };

  const confirmMissingAndSend = async () => {
    if (!child || child.persisted) return;
    const created = await persistChild(true);
    if (!created) return;
    const pending = pendingSendRef.current.trim();
    pendingSendRef.current = '';
    conversationStore.adoptBucket(child.id, created.conversationId);
    if (pending) {
      conversationStore.setDraft(created.conversationId, pending);
      setPendingSendText(pending);
    }
  };

  const close = async () => {
    if (!child || saving) return;
    openGeneration.current += 1;
    if (!child.persisted) {
      // 未发送的草稿直接丢弃，不落盘。
      conversationStore.reset(child.id);
      setChild(null);
      setError('');
      return;
    }
    setSaving(true);
    try {
      const text = conversationStore.getSnapshot(child.id).draft;
      await clientApi.selectionSaveDraft({ conversationId: child.id, text, referenceIds: [child.reference.id] });
      setChild(null);
      setError('');
    } catch (cause) { setError(`草稿保存失败，侧栏保持打开：${String(cause)}`); }
    finally { setSaving(false); }
  };
  const childVisible = child?.parentId === props.conversationId;
  return <>
    {children.length ? <nav aria-label="子会话">{children.map((item) => <button key={item.id} type="button" onClick={() => void open(item.id)}>{item.title} · {item.lifecycle} · {item.runState}</button>)}</nav> : null}
    {error && error !== 'BACKGROUND_CONFIRMATION_REQUIRED' ? <div role="alert">{error}</div> : null}
    <ChatSurface {...props} isPageActive={props.isPageActive && !childVisible} onOpenSelectionChild={(payload) => openDraft(payload)} />
    {child && childVisible ? <Drawer onClose={() => void close()} ariaLabel="子会话讨论" panelClassName="conversation-result-drawer conversation-chat-drawer" softBackdrop>
      <WorkbenchProvider conversationId={child.persisted ? child.id : null} isPageActive={Boolean(props.isPageActive)} layoutHost="local">
        {error === 'BACKGROUND_CONFIRMATION_REQUIRED' ? (
          <div className="selection-action-toolbar__confirm" role="alertdialog" aria-label="背景不完整确认">
            <span role="alert">背景不完整：部分附件或工具材料尚未解析，不会作为完整材料继承。仍要使用可用背景创建子会话吗？</span>
            <div className="selection-action-toolbar__actions">
              <button type="button" onClick={() => setError('')}>取消</button>
              <button type="button" onClick={() => { void confirmMissingAndSend(); }}>仍然创建</button>
            </div>
          </div>
        ) : null}
        <ChatSurface i18n={props.i18n} providers={props.providers} conversationId={child.id}
          conversationTitle={child.title} workspacePath={child.workspacePath} workspaces={props.workspaces}
          onOpenSettings={props.onOpenSettings}
          systemInstructions={props.systemInstructions} replyLanguage={props.replyLanguage}
          isPageActive={props.isPageActive} onConversationUpdated={props.onConversationUpdated}
          onStreamingChange={props.onStreamingChange} onClose={() => void close()}
          onSelectionChildSend={!child.persisted ? createChildOnSend : undefined}
          pendingSendText={child.persisted ? pendingSendText : undefined}
          onPendingSendConsumed={() => setPendingSendText('')}
          banner={<div role="note">只讨论 · 已继承创建时背景<blockquote>{child.reference.exactText}</blockquote></div>} />
      </WorkbenchProvider>
    </Drawer> : null}
  </>;
}
