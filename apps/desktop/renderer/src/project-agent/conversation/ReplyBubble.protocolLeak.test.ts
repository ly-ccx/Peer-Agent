import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import { stripHistoricalLocalRecordForDisplay } from '../../chat/state/historicalLocalRecord.ts';

function loadReplyBubble() {
  const renderedMarkdown: string[] = [];
  const quotedValues: string[] = [];
  let replyContextQuote: (() => void) | undefined;

  const stubComponent = (name: string) => (props: Record<string, unknown>) => {
    if (name === 'MarkdownMessage' && typeof props.content === 'string') {
      renderedMarkdown.push(props.content);
    }
    if (name === 'ReplyContext') {
      replyContextQuote = typeof props.onQuote === 'function' ? (props.onQuote as () => void) : undefined;
    }
    if (name === 'BotNarration' && Array.isArray(props.segments)) {
      for (const seg of props.segments as Array<{ text?: string }>) {
        if (typeof seg?.text === 'string') renderedMarkdown.push(seg.text);
      }
    }
    return { type: name, props };
  };

  const dependencies: Record<string, unknown> = {
    react: { useRef: (current: unknown) => ({ current }) },
    'react/jsx-runtime': jsxRuntime,
    '../../chat/components/markdown/MarkdownMessage': { MarkdownMessage: stubComponent('MarkdownMessage') },
    '../../chat/state/historicalLocalRecord': { stripHistoricalLocalRecordForDisplay },
    './ReplyResourceContext': {
      ReplyResourceContext: ({ children }: { children: unknown }) => children,
    },
    './BotSelectionQuote': { BotSelectionQuote: stubComponent('BotSelectionQuote') },
    './ReplyContext': { ReplyContext: stubComponent('ReplyContext') },
    './CardView': { CardView: stubComponent('CardView') },
    './ReplyAnchors': { ReplyAnchors: stubComponent('ReplyAnchors') },
    './BotNarration': { BotNarration: stubComponent('BotNarration') },
    './ReplyTaskReferences': { ReplyTaskReferences: stubComponent('ReplyTaskReferences') },
  };

  const exports: Record<string, any> = {};
  const source = readFileSync(new URL('./ReplyBubble.tsx', import.meta.url), 'utf8');
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    {
      exports,
      require(id: string) {
        if (id in dependencies) return dependencies[id];
        return new Proxy({}, { get: (_t, prop) => stubComponent(String(prop)) });
      },
    },
  );

  function collect(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === 'function') {
      const out = (el.type as (p: Record<string, unknown>) => unknown)(el.props ?? {});
      collect(out);
      return;
    }
    if (el.props && 'children' in el.props) collect(el.props.children);
  }

  return {
    render(content: string, narration: Array<{ id: string; text: string }> = []) {
      renderedMarkdown.length = 0;
      quotedValues.length = 0;
      replyContextQuote = undefined;
      const tree = exports.ReplyBubble({
        workspaceId: 'ws-1',
        message: {
          id: 'm-1',
          role: 'assistant',
          kind: 'agent_reply',
          content,
          createdAt: '2026-11-22T14:12:00.000Z',
          replyTo: [],
          sources: [],
          cards: [],
        },
        referenceIds: [],
        anchors: new Map(),
        highlighted: false,
        i18n: {
          t: (key: string) =>
            key === 'projectAgent.chat.protocolLeakFallback'
              ? '该回复仅包含无效的工具调用格式，已自动隐藏。请重试或继续追问。'
              : key,
        },
        onJump() {},
        onQuote(excerpt: string) {
          quotedValues.push(excerpt);
        },
        workIndex: { sessions: new Map(), tasks: new Map(), resources: new Map() },
        onOpenWork() {},
        narration,
      });
      collect(tree);
      return {
        rendered: [...renderedMarkdown],
        replyContextQuote,
        triggerQuote: () => {
          replyContextQuote?.();
          return [...quotedValues];
        },
      };
    },
  };
}

test('ReplyBubble replaces pure DSML markup with localized fallback and disables quoting raw markup', () => {
  const harness = loadReplyBubble();
  const dsml = [
    '',
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="read_file">',
    '<｜DSML｜ parameter name="path" string="true">a.css</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
  ].join('\n');

  const pure = harness.render(dsml, [{ id: 'seg-1', text: dsml }]);
  assert.deepEqual(pure.rendered, ['该回复仅包含无效的工具调用格式，已自动隐藏。请重试或继续追问。']);
  assert.equal(pure.replyContextQuote, undefined);

  const mixed = harness.render(`前一半排查完成。\n\n${dsml}`);
  assert.deepEqual(mixed.rendered, ['前一半排查完成。']);
  assert.deepEqual(mixed.triggerQuote(), ['前一半排查完成。']);
});

function loadContinuousAndNarration() {
  const renderedMarkdown: string[] = [];
  const renderedBodyCount = { value: 0 };
  let capturedPresenceQuote: (() => void) | undefined;
  let selectionQuoteCount = 0;

  const stubComponent = (name: string) => (props: Record<string, unknown>) => {
    if (name === 'MarkdownMessage' && typeof props.content === 'string') {
      renderedMarkdown.push(props.content);
    }
    if (name === 'ReplyPresence') {
      capturedPresenceQuote = typeof props.onQuote === 'function' ? (props.onQuote as () => void) : undefined;
    }
    if (name === 'BotSelectionQuote') {
      selectionQuoteCount += 1;
    }
    return { type: name, props };
  };

  const dependencies: Record<string, unknown> = {
    react: { useRef: (current: unknown) => ({ current }) },
    'react/jsx-runtime': jsxRuntime,
    '../../chat/components/markdown/MarkdownMessage': { MarkdownMessage: stubComponent('MarkdownMessage') },
    '../../chat/state/historicalLocalRecord': { stripHistoricalLocalRecordForDisplay },
    '../state/botActivityState': { isActivityRunning: (act: { phase?: string } | null) => act?.phase === 'responding' },
    '../state/botResourceReference': { referencesForReplyParagraph: () => [] },
    './ReplyResourceContext': {
      ReplyResourceContext: ({ children }: { children: unknown }) => children,
    },
    './BotSelectionQuote': { BotSelectionQuote: stubComponent('BotSelectionQuote') },
    './CardView': { CardView: stubComponent('CardView') },
    './ReplyAnchors': { ReplyAnchors: stubComponent('ReplyAnchors') },
    './ReplyPresence': { ReplyPresence: stubComponent('ReplyPresence') },
    './ReplyTaskReferences': { ReplyTaskReferences: stubComponent('ReplyTaskReferences') },
  };

  const loadModule = (file: string) => {
    const exports: Record<string, any> = {};
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
      {
        exports,
        require(id: string) {
          if (id in dependencies) return dependencies[id];
          return new Proxy({}, { get: (_t, prop) => stubComponent(String(prop)) });
        },
      },
    );
    return exports;
  };

  const { ContinuousReply } = loadModule('./ContinuousReply.tsx');
  const { BotNarration } = loadModule('./BotNarration.tsx');

  function collect(node: unknown) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.props?.className === 'string' && el.props.className.includes('bot-reply-body')) {
      renderedBodyCount.value += 1;
    }
    if (typeof el.type === 'function') {
      collect((el.type as (p: Record<string, unknown>) => unknown)(el.props ?? {}));
      return;
    }
    if (el.props && 'children' in el.props) collect(el.props.children);
  }

  return {
    renderContinuous(reply: Record<string, unknown>) {
      renderedMarkdown.length = 0;
      renderedBodyCount.value = 0;
      capturedPresenceQuote = undefined;
      selectionQuoteCount = 0;
      const quoted: Array<{ id: string; excerpt: string }> = [];
      const tree = ContinuousReply({
        workspaceId: 'ws-1',
        reply,
        referenceIds: [],
        anchors: new Map(),
        highlighted: false,
        i18n: {
          t: (key: string) =>
            key === 'projectAgent.chat.protocolLeakFallback'
              ? '该回复仅包含无效的工具调用格式，已自动隐藏。请重试或继续追问。'
              : key,
        },
        onJump() {},
        onQuote(id: string, excerpt: string) {
          quoted.push({ id, excerpt });
        },
        onReload() {},
        workIndex: { sessions: new Map(), tasks: new Map(), resources: new Map() },
        onOpenWork() {},
      });
      collect(tree);
      return {
        rendered: [...renderedMarkdown],
        bodyCount: renderedBodyCount.value,
        hasQuoteButton: Boolean(capturedPresenceQuote),
        selectionQuoteCount,
        triggerQuote: () => {
          capturedPresenceQuote?.();
          return quoted;
        },
      };
    },
    renderNarration(segments: Array<{ id: string; text: string }>) {
      renderedMarkdown.length = 0;
      renderedBodyCount.value = 0;
      const tree = BotNarration({ segments });
      if (tree === null) return { isNull: true, rendered: [] as string[], bodyCount: 0 };
      collect(tree);
      return { isNull: false, rendered: [...renderedMarkdown], bodyCount: renderedBodyCount.value };
    },
  };
}

test('ContinuousReply and BotNarration hide pure DSML pills and preserve clean prose quoting', () => {
  const harness = loadContinuousAndNarration();
  const dsml = '<｜DSML｜ calls>\n<｜DSML｜ invoke name="read_file">\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

  const deliveredPure = harness.renderContinuous({
    type: 'reply',
    id: 'reply-1',
    replyTo: [],
    aliases: ['turn-1', 'reply-1'],
    messages: [],
    paragraphs: [{ id: 'turn-1:conclusion', text: dsml }],
    message: {
      id: 'reply-msg-1',
      role: 'assistant',
      kind: 'agent_reply',
      content: dsml,
      createdAt: '2026-11-22T14:12:00.000Z',
      replyTo: [],
      sources: [],
      cards: [],
    },
  });
  assert.deepEqual(deliveredPure.rendered, ['该回复仅包含无效的工具调用格式，已自动隐藏。请重试或继续追问。']);
  assert.equal(deliveredPure.bodyCount, 1);
  assert.equal(deliveredPure.hasQuoteButton, false);
  assert.equal(deliveredPure.selectionQuoteCount, 0);

  const deliveredMixed = harness.renderContinuous({
    type: 'reply',
    id: 'reply-2',
    replyTo: [],
    aliases: ['turn-2', 'reply-2'],
    messages: [],
    paragraphs: [{ id: 'turn-2:conclusion', text: `已完成检查。\n\n${dsml}` }],
    message: {
      id: 'reply-msg-2',
      role: 'assistant',
      kind: 'agent_reply',
      content: `已完成检查。\n\n${dsml}`,
      createdAt: '2026-11-22T14:12:05.000Z',
      replyTo: [],
      sources: [],
      cards: [],
    },
  });
  assert.deepEqual(deliveredMixed.rendered, ['已完成检查。']);
  assert.equal(deliveredMixed.hasQuoteButton, true);
  assert.equal(deliveredMixed.selectionQuoteCount, 1);
  assert.deepEqual(deliveredMixed.triggerQuote(), [{ id: 'reply-msg-2', excerpt: '已完成检查。' }]);

  const livePure = harness.renderContinuous({
    type: 'reply',
    id: 'reply-3',
    replyTo: [],
    aliases: ['turn-3'],
    messages: [],
    paragraphs: [{ id: 'turn-3:conclusion', text: dsml }],
    activity: { turnId: 'turn-3', phase: 'responding', replyText: dsml },
  });
  assert.deepEqual(livePure.rendered, []);
  assert.equal(livePure.bodyCount, 0);

  const narration = harness.renderNarration([{ id: 'seg-1', text: dsml }]);
  assert.equal(narration.isNull, true);
  assert.equal(narration.bodyCount, 0);
});
