import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const jsx = { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) };
function load(file: string, modules: Record<string, unknown> = {}) {
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(id: string) {
      if (id === 'react/jsx-runtime') return jsx;
      if (id === 'react') return { useState: (value: unknown) => [value, () => {}] };
      if (id.endsWith('.css')) return {};
      if (id === '../../ui/icons') return { PeerIcon: 'icon' };
      if (id === '../../clientApi' && !(id in modules)) return { clientApi: { projectAgentSetUnknownOutcomePolicy: async () => ({ ok: false }) } };
      if (id in modules) return modules[id];
      throw Error(id);
    },
  });
  return exports;
}
const text = (node: any): string => Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : '';
const i18n = { t: (key: string) => key };

function grant(actions: string[]) {
  return { grantId: 'grant-1', status: 'pending', items: [{ sessionId: 'session-1', title: '旧任务', gaps: [], actions }] };
}
function render(actions: string[]) {
  const card = load('./ObligationGrantCard.tsx', {});
  return card.ObligationGrantCard({ grant: grant(actions), submitting: false, blocked: null, i18n,
    onConfirm: () => {}, onReject: () => {} });
}

test('close_claim shows the release consequence and per-item badge', () => {
  const tree = render(['acknowledge_unknown', 'close_claim']);
  const body = text(tree);
  assert.ok(body.includes('projectAgent.workPanel.obligationConsequenceRelease'), body);
  assert.ok(body.includes('projectAgent.workPanel.obligationReleaseItem'), body);
  assert.ok(body.includes('projectAgent.workPanel.obligationConfirmRelease'), body);
  assert.equal(/(^|\s)projectAgent\.workPanel\.obligationConsequence(\s|$)/.test(body), false);
});

test('retire-only grants keep the existing consequence and never claim release', () => {
  const tree = render(['retire_follow_up', 'acknowledge_unknown']);
  const body = text(tree);
  assert.ok(body.includes('projectAgent.workPanel.obligationConsequence'), body);
  assert.ok(body.includes('projectAgent.workPanel.obligationConfirm'), body);
  assert.equal(body.includes('obligationConsequenceRelease'), false);
  assert.equal(body.includes('obligationConfirmRelease'), false);
  assert.equal(body.includes('obligationReleaseItem'), false);
});

test('an eligible reconciliation fact offers in-card delegation; bot_verified shows the receipt line only', () => {
  const clientApi = { projectAgentSetUnknownOutcomePolicy: async () => ({ ok: true }) };
  const { ObligationGrantCard } = load('./ObligationGrantCard.tsx', { '../../clientApi': { clientApi } });
  const eligible = [{ sessionId: 'session-1', title: '旧任务', gaps: [], actions: ['close_claim'],
    unknownOutcome: { policyTier: 'ask', reconciliation: { eligible: true, verdict: 'no_effect_observed' } } }];
  const offered = ObligationGrantCard({ grant: { grantId: 'g', status: 'pending', items: eligible },
    submitting: false, blocked: null, i18n, onConfirm: () => {}, onReject: () => {}, workspaceId: 'w' });
  const offeredText = text(offered);
  assert.ok(offeredText.includes('projectAgent.workPanel.obligationVerdictNoEffect'), offeredText);
  assert.ok(offeredText.includes('projectAgent.workPanel.obligationDelegationAction'), offeredText);

  const delegated = [{ ...eligible[0], unknownOutcome: { policyTier: 'bot_verified', reconciliation: { eligible: true, verdict: 'no_effect_observed' } } }];
  const delegatedText = text(ObligationGrantCard({ grant: { grantId: 'g', status: 'pending', items: delegated },
    submitting: false, blocked: null, i18n, onConfirm: () => {}, onReject: () => {}, workspaceId: 'w' }));
  assert.ok(delegatedText.includes('projectAgent.workPanel.obligationDelegationDone'), delegatedText);
  assert.equal(delegatedText.includes('projectAgent.workPanel.obligationDelegationAction'), false);

  const ineligible = [{ sessionId: 'session-1', title: '旧任务', gaps: [], actions: ['close_claim'],
    unknownOutcome: { policyTier: 'ask', reconciliation: { eligible: false, reason: 'reconciliation_missing' } } }];
  const ineligibleText = text(ObligationGrantCard({ grant: { grantId: 'g', status: 'pending', items: ineligible },
    submitting: false, blocked: null, i18n, onConfirm: () => {}, onReject: () => {}, workspaceId: 'w' }));
  assert.equal(ineligibleText.includes('obligationDelegation'), false, 'no evidence, no delegation entry');
  assert.equal(ineligibleText.includes('obligationVerdict'), false, 'no verdict line without an eligible reconciliation');
});
