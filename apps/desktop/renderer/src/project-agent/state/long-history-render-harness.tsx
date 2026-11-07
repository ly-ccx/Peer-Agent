/**
 * 真实渲染组件的长历史场景。调用方提供 document，并且不接模型端口。
 * 历史列表和输入框分开订阅，逐字修改草稿时历史投影不重算。
 */
import { memo, useMemo, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { emptyInputDraft, type ProjectInputRecoveryPort } from '@peer-agent/protocol';
import { createProjectInputRecovery } from '@peer-agent/runtime-core';
import type { I18nRuntime } from '@peer-agent/i18n';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { advanceMarkdownOpenSlot, type MarkdownOpenSlot } from '../../chat/state/streamingMarkdownSlot';
import { BotComposer } from '../conversation/BotComposer';
import { ConversationRow } from '../conversation/ConversationRow';
import { normalizeBotMessage, projectConversationRows, windowConversationRows, type BotChatMessage, type ConversationProjection } from './botConversationState';

const HISTORY = 4000;
const KEYS = 40;
const CHUNKS = 40;
const CHUNK = '一点';
const OPENING = '第一段已经写完。\n\n第二段也已经写完。\n\n正在写';

export interface LongHistoryRenderResult {
  readonly history: number;
  readonly window: number;
  readonly domRows: number;
  readonly historyRendersAtRest: number;
  readonly historyRendersAfterKeys: number;
  readonly fullScans: number;
  readonly tailUpdates: number;
  readonly markdownAtRest: number;
  readonly markdownAfterChunks: number;
  readonly keyMs: number;
  readonly chunkMs: number;
  readonly draft: string;
  readonly tail: string;
  readonly closedStable: boolean;
  readonly writes: number;
  readonly submits: number;
}

let historyRenders = 0;
let fullScans = 0;
let tailUpdates = 0;
let markdownRenders = 0;
let projection: ConversationProjection | null = null;

const CountedMarkdown = memo(function CountedMarkdown(props: ComponentProps<typeof MarkdownMessage>) {
  markdownRenders += 1;
  return <MarkdownMessage {...props} />;
});

const History = memo(function History({ messages, tail, slot }: {
  readonly messages: readonly BotChatMessage[];
  readonly tail: string;
  readonly slot: MarkdownOpenSlot;
}) {
  historyRenders += 1;
  const shown = useMemo(() => {
    const next = messages.slice();
    const last = next[next.length - 1];
    if (last) next[next.length - 1] = { ...last, content: tail };
    return next;
  }, [messages, tail]);
  const projected = useMemo(() => {
    const next = projectConversationRows(shown, projection);
    projection = next;
    if (next.projection === 'full') fullScans += 1;
    else tailUpdates += 1;
    return next;
  }, [shown]);
  const rows = projected.rows;
  const windowed = useMemo(() => windowConversationRows(rows, rows.length - 1, 80), [rows]);
  const tailId = shown[shown.length - 1]?.id;
  return (
    <div data-history-count={messages.length} data-window-count={windowed.rows.length}>
      {windowed.rows.map(row => row.type === 'message' ? (
        <ConversationRow key={row.message.id} rowKey={row.message.id} entering={false} className="row">
          {row.message.kind === 'agent_reply'
            ? <CountedMarkdown content={row.message.content} openSlot={row.message.id === tailId ? slot : null} />
            : <p>{row.message.content}</p>}
        </ConversationRow>
      ) : null)}
    </div>
  );
});

function messages(): BotChatMessage[] {
  const rows: BotChatMessage[] = [];
  for (let index = 0; index < HISTORY; index += 1) {
    const user = index % 2 === 0;
    const last = index === HISTORY - 1;
    const message = normalizeBotMessage({
      id: `m-${index}`,
      kind: user && !last ? 'user_input' : 'agent_reply',
      role: user && !last ? 'user' : 'assistant',
      content: last ? OPENING : (user ? `问题 ${index}` : `回答 ${index}`),
      createdAt: '2026-11-07T03:00:00.000Z',
    });
    if (!message) throw new Error('message');
    rows.push(message);
  }
  return rows;
}

export async function runLongHistoryScenario(): Promise<LongHistoryRenderResult> {
  historyRenders = 0;
  fullScans = 0;
  tailUpdates = 0;
  markdownRenders = 0;
  projection = null;
  const writes: string[] = [];
  let submits = 0;
  const port: ProjectInputRecoveryPort = {
    read: async () => ({ ok: true, snapshot: { revision: 0, draft: emptyInputDraft(), pending: [] } }),
    write: async request => {
      writes.push(request.draft.text);
      return { ok: true, revision: writes.length };
    },
    submit: async () => {
      submits += 1;
      return { ok: false, code: 'NOT_SENT' };
    },
  };
  const session = createProjectInputRecovery({
    workspaceId: 'synthetic-bot', surface: 'desktop', port, createId: () => 'input-1',
  });
  if (!await session.load()) throw new Error('draft did not load');
  const history = messages();
  const rootNode = document.getElementById('root');
  if (!rootNode) throw new Error('root');
  const root = createRoot(rootNode);
  let append = (_chunk: string) => {};
  let readStream = () => ({ tail: OPENING, slot: advanceMarkdownOpenSlot(null, OPENING) });
  function App() {
    const [stream, setStream] = useState(() => {
      const slot = advanceMarkdownOpenSlot(null, OPENING);
      return { tail: OPENING, slot };
    });
    append = (chunk: string) => {
      setStream(current => {
        const tail = current.tail + chunk;
        return { tail, slot: advanceMarkdownOpenSlot(current.slot, tail) };
      });
    };
    readStream = () => stream;
    return (
      <main>
        <History messages={history} tail={stream.tail} slot={stream.slot} />
        <Composer session={session} onSend={() => { submits += 1; }} />
      </main>
    );
  }
  function Composer({ session: input, onSend }: {
    readonly session: typeof session;
    readonly onSend: () => void;
  }) {
    const view = useSyncExternalStore(input.subscribe, input.getSnapshot, input.getSnapshot);
    return (
      <BotComposer
        i18n={{ locale: 'zh-CN', t: (key: string) => key, localize: (fallback: string) => fallback, capabilityName: () => '', capabilityDescription: () => '' } as I18nRuntime}
        botName="合成"
        draft={view.draft}
        ready={view.ready}
        quote=""
        onQuoteRemove={() => {}}
        onDraftChange={patch => input.edit(patch)}
        onSend={onSend}
        predictionContext={{ workspaceId: 'synthetic-bot', conversationId: 'synthetic', version: '0', eligible: false }}
      />
    );
  }
  await act(async () => { root.render(<App />); });
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('composer textarea was not mounted');
  const atRest = historyRenders;
  const markdownAtRest = markdownRenders;
  const initialClosed = readStream().slot.closed;
  let text = '';
  const keyStarted = performance.now();
  await act(async () => {
    for (let index = 0; index < KEYS; index += 1) {
      text += '字';
      textarea.value = text;
      const event = new Event('input', { bubbles: true }) as Event & { inputType: string };
      event.inputType = 'insertText';
      textarea.dispatchEvent(event);
    }
    await session.flush();
  });
  const keyMs = performance.now() - keyStarted;
  const afterKeys = historyRenders;
  if (fullScans !== 1 || tailUpdates !== 0) throw new Error(`keystrokes changed projection full=${fullScans} tail=${tailUpdates}`);
  const chunkStarted = performance.now();
  for (let index = 0; index < CHUNKS; index += 1) {
    await act(async () => { append(CHUNK); });
  }
  const chunkMs = performance.now() - chunkStarted;
  const stream = readStream();
  const windowCount = Number(document.querySelector('[data-window-count]')?.getAttribute('data-window-count'));
  const historyCount = Number(document.querySelector('[data-history-count]')?.getAttribute('data-history-count'));
  const result: LongHistoryRenderResult = {
    history: historyCount,
    window: windowCount,
    domRows: document.querySelectorAll('[data-conversation-row]').length,
    historyRendersAtRest: atRest,
    historyRendersAfterKeys: afterKeys,
    fullScans,
    tailUpdates,
    markdownAtRest,
    markdownAfterChunks: markdownRenders,
    keyMs,
    chunkMs,
    draft: session.getSnapshot().draft.text,
    tail: stream.tail,
    closedStable: stream.slot.closed === initialClosed,
    writes: writes.length,
    submits,
  };
  await act(async () => { root.unmount(); });
  if (fullScans < 1) throw new Error('history was not projected');
  return result;
}
