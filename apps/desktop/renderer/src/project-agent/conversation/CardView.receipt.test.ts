import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';
import { approvalCardReceipt, cardDecisionKey } from '../state/cardDecisionReceipt.ts';
import type { BotChatCard } from '../state/botConversationState.ts';

type Element = { type: unknown; props: Record<string, unknown> };
const jsx = { jsx: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>): Element => ({ type, props }) };
const source: BotChatCard = { cardId: 'card:approval:a', kind: 'approval', content: 'read image',
  resolvedState: 'open', refs: { approvalId: 'a', capabilityId: 'local.image.read' },
  actions: ['allow', 'task', 'deny', 'cancel'].map(id => ({ id })) };
const i18n = createI18n('zh-CN');
const output: { CardView?: (props: Record<string, unknown>) => Element } = {};
let hook = 0;
let states: unknown[] = [];
const modules: Record<string, unknown> = {
  react: { useState: () => [states[hook++], () => {}], useRef: () => ({ current: false }), useContext: () => null },
  'react/jsx-runtime': jsx,
  '../state/cardDecisionReceipt': { approvalCardReceipt, cardDecisionKey },
  '../state/useInputRecovery': {}, '../../clientApi': {},
  '../../chat/components/markdown/MarkdownMessage': { MarkdownMessage: 'markdown' },
  '../../ui/icons': { PeerIcon: 'icon' },
  '../state/botConversationState': {}, '../state/replyRecoveryState': {}, '../state/cardActionError': {},
  './CompletionReview': { CompletionReview: 'review' }, './BotInputContext': { BotInputContext: {} },
  './useQuestionDismissal': { useQuestionDismissal: () => ({ present: true }) },
  './useCardPresence': { useCardPresence: (cards: BotChatCard[]) => ({ visible: cards, close() {} }) },
  './ApprovalReceipt': { ApprovalReceipt: 'receipt' },
};
runInNewContext(ts.transpileModule(readFileSync(new URL('./CardView.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: output, require(id: string) {
  if (id in modules) return modules[id]; throw new Error(id);
} });
function render(card: BotChatCard, workspaceId = 'w', result: unknown = {
  approval: { workspaceId: 'w', approvalId: 'a', state: 'approved' },
}): Element {
  const factual = approvalCardReceipt('w', source, result);
  states = [false, '', factual ? { key: `w:${cardDecisionKey(source)}`, source, card: factual } : null, null, null];
  hook = 0;
  assert.ok(output.CardView);
  const list = output.CardView({ workspaceId, cards: [card], i18n });
  const children = list.props.children as Element[];
  const item = children[0]; assert.ok(typeof item.type === 'function');
  return item.type(item.props) as Element;
}
function buttons(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + buttons(child), 0);
  if (!node || typeof node !== 'object') return 0;
  const element = node as Element;
  return (element.type === 'button' ? 1 : 0) + buttons(element.props?.children);
}

test('a factual approval receipt survives an equal pending projection with a new object identity', () => {
  const card = structuredClone(source);
  assert.notEqual(card, source);
  const tree = render(card);
  assert.equal(tree.type, 'receipt');
  assert.equal(buttons(tree), 0);
});
test('changed challenge, changed scope and missing host proof cannot reuse a cached receipt', () => {
  assert.equal(buttons(render({ ...source, refs: { ...source.refs, approvalId: 'new' } })), 4);
  assert.equal(buttons(render(structuredClone(source), 'another-workspace')), 4);
  assert.equal(buttons(render(structuredClone(source), 'w', { ok: true })), 4);
});
test('new terminal source facts win over the local receipt', () => {
  const tree = render({ ...source, resolvedState: 'resolved', resolution: { state: 'denied' }, actions: [] });
  assert.equal(tree.type, 'receipt');
  assert.equal((tree.props.card as BotChatCard).resolution?.state, 'denied');
});
