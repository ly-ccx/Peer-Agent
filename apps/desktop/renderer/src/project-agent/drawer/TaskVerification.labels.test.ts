import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createI18n } from '@peer-agent/i18n';

// The component is a pure projection of host facts; render it without a DOM.
const exports: Record<string, any> = {};
const jsx = { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) };
const modules: Record<string, unknown> = {
  'react/jsx-runtime': jsx,
  '../../app/components/MotionDetails': { MotionDetails: 'details' },
  './EvidencePreview': { EvidencePreview: 'evidence' },
  '../../ui/icons': { PeerIcon: 'icon' },
};
runInNewContext(ts.transpileModule(readFileSync(new URL('./TaskVerification.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require(id: string) { if (id in modules) return modules[id]; throw new Error(id); } });

function checkLabels(checks: unknown[]): { labels: string[]; results: string[] } {
  const tree = exports.TaskVerification({ i18n: createI18n('zh-CN'), detail: {
    sessionId: 's', outcome: 'passed', checks, workerModel: null, verifierModel: null,
    sameSource: false, reviewAttempts: [], outputs: [],
  } });
  const labels: string[] = [];
  const results: string[] = [];
  const visit = (node: any) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'dt') labels.push(node.props.children);
    if (node.type === 'dd') results.push(node.props.children);
    visit(node.props?.children);
  };
  visit(tree);
  return { labels, results };
}
const check = (name: string, result: 'passed' | 'failed', reason?: string) => ({ name, result, reason, evidenceRefs: [] });

test('a review the task did not need and unreviewed quality criteria are stated as facts', () => {
  assert.deepEqual(checkLabels([
    check('leaf_evidence', 'passed'),
    check('independent_verifier', 'passed', 'not_required'),
    check('model_review', 'failed', 'not_reviewed'),
  ]), {
    labels: ['任务结果与证据', '独立复核', '质量标准'],
    results: ['通过', '无需独立核验', '未经独立核验'],
  });
});

test('reviewed checks keep their pass, fail and missing wording', () => {
  assert.deepEqual(checkLabels([
    check('leaf_evidence', 'passed'),
    check('independent_verifier', 'passed'),
    check('independent_verifier', 'failed', 'failed'),
    check('independent_verifier', 'failed', 'missing'),
    check('independent_verifier', 'failed'),
    check('unlisted', 'failed'),
  ]), {
    labels: ['任务结果与证据', '独立复核', '独立复核', '独立复核', '独立复核', '其他检查'],
    results: ['通过', '通过', '未通过', '尚未核验', '未通过', '未通过'],
  });
});
