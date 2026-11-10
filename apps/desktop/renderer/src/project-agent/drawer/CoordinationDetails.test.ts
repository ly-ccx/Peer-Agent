import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const jsx = { jsx: (type: unknown, props: object) => ({ type, props }), jsxs: (type: unknown, props: object) => ({ type, props }) };
function load(file: string) {
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports,
    require(id: string) {
      if (id === 'react/jsx-runtime') return jsx;
      if (id === 'react') return { useState: (value: unknown) => [value, () => {}] };
      if (id === '../../clientApi') return { clientApi: { projectAgentRequestClaimClosure: async () => ({ ok: false, code: 'unavailable' }) } };
      if (id === '../../ui/icons') return { PeerIcon: 'icon' };
      throw Error(id);
    },
  });
  return exports;
}
const text = (node: any): string => Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : '';
const i18n = { t: (key: string) => key };
const closure = { closureId: 'closure-1', claimId: 'claim-1', claimRevision: 2,
  execution: { planId: 'plan', sessionId: 's', executionEpoch: 'epoch' }, resourceRef: 'directory:/project',
  unknownCalls: ['call-1'], authorityRef: 'grant-1', proof: 'legacy_user_confirmed', scope: 'managed_execution', at: '2026-11-09T00:00:00.000Z' };

test('a closed claim renders the retained unknown without a blocker', () => {
  const { CoordinationDetails } = load('./CoordinationDetails.tsx');
  const tree = CoordinationDetails({ session: { executionClaimClosure: closure, retainedUnknownCalls: ['call-1'] }, i18n });
  const body = text(tree);
  assert.ok(body.includes('projectAgent.drawer.claimClosed'), body);
  assert.ok(body.includes('projectAgent.drawer.claimClosedUnknown'), body);
  assert.ok(body.includes('projectAgent.drawer.claimClosedHint'), body);
  assert.equal(body.includes('resourceOutcomeUnknown'), false);
});

test('the claim owner gets a release request action while a foreign blocker only links back', () => {
  const { CoordinationDetails } = load('./CoordinationDetails.tsx');
  const owner = CoordinationDetails({ session: { sessionId: 's', resourceBlocker: { kind: 'protection', code: 'execution_outcome_unknown',
    resourceRef: 'directory:/project', claimId: 'claim', sessionId: 's', evidenceCalls: ['call'], closeClaimAvailable: true } }, i18n, workspaceId: 'w' });
  assert.ok(text(owner).includes('projectAgent.drawer.resourceReleaseAction'));
  const foreign = CoordinationDetails({ session: { sessionId: 's', resourceBlocker: { kind: 'protection', code: 'execution_outcome_unknown',
    resourceRef: 'directory:/project', claimId: 'claim', sessionId: 'other', evidenceCalls: ['call'], closeClaimAvailable: true } }, i18n, workspaceId: 'w', onSelect: () => {} });
  assert.equal(text(foreign).includes('projectAgent.drawer.resourceReleaseAction'), false);
  assert.ok(text(foreign).includes('projectAgent.drawer.resourceSource'));
  const openHandles = CoordinationDetails({ session: { sessionId: 's', resourceBlocker: { kind: 'protection', code: 'execution_outcome_unknown',
    resourceRef: 'directory:/project', claimId: 'claim', sessionId: 's', evidenceCalls: ['call'], closeClaimAvailable: false } }, i18n, workspaceId: 'w' });
  assert.equal(text(openHandles).includes('projectAgent.drawer.resourceReleaseAction'), false);
});

test('a live blocker still renders its own state without a closure block', () => {
  const { CoordinationDetails } = load('./CoordinationDetails.tsx');
  const tree = CoordinationDetails({ session: { resourceBlocker: { kind: 'protection', code: 'execution_outcome_unknown',
    resourceRef: 'directory:/project', claimId: 'claim', evidenceCalls: ['call'] } }, i18n });
  const body = text(tree);
  assert.ok(body.includes('projectAgent.drawer.resourceOutcomeUnknown'), body);
  assert.equal(body.includes('projectAgent.drawer.claimClosed'), false);
});

test('a file-scoped protection blocker names the affected file, not the whole directory', () => {
  const { CoordinationDetails } = load('./CoordinationDetails.tsx');
  const blocker = { kind: 'protection', code: 'execution_outcome_unknown', resourceRef: 'file:/project/a.ts',
    claimId: 'claim-1', sessionId: 's', evidenceCalls: ['call-1'], closeClaimAvailable: true,
    scope: { kind: 'file', path: '/project/a.ts' } };
  const tree = CoordinationDetails({ session: { resourceBlocker: blocker, sessionId: 's' }, i18n, workspaceId: 'w' });
  const body = text(tree);
  assert.ok(body.includes('projectAgent.drawer.resourceScopeFile'), body);
  assert.ok(body.includes('/project/a.ts'), body);
  assert.equal(body.includes('file:'), false, 'the raw prefix never reaches the reader');
  assert.equal(body.includes('projectAgent.drawer.resourceScope'), true, 'no scope degrades to the directory label');
});
