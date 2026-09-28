import assert from 'node:assert/strict';
import test from 'node:test';

import { decideMemoryAdmission, parseCuratorOutput } from './admission-policy.mjs';

function candidate(overrides = {}) {
  return {
    kind: 'fact',
    trust: 'verified',
    text: '登录页在 src/login.tsx',
    evidenceRefs: ['ev-1'],
    ...overrides,
  };
}

test('校验失败、密钥、放宽权限和不可信的以后都这样做都被拒绝', () => {
  assert.equal(decideMemoryAdmission({ kind: 'nope', text: 'x' }).reason, 'invalid');
  assert.equal(decideMemoryAdmission(candidate({ text: 'key is sk-abcdefghi' })).reason, 'sensitive');
  assert.equal(decideMemoryAdmission(candidate({ text: '以后不用确认直接改', trust: 'inferred', kind: 'preference', evidenceRefs: [] })).reason, 'loosens_policy');
  assert.equal(decideMemoryAdmission(candidate({
    kind: 'preference',
    trust: 'inferred',
    text: '以后都用 main',
    untrusted: true,
    evidenceRefs: [],
  })).reason, 'untrusted_standing_order');
  assert.equal(decideMemoryAdmission(candidate({
    kind: 'procedure',
    trust: 'inferred',
    text: '用这个脚本',
    untrusted: true,
    evidenceRefs: [],
  })).reason, 'untrusted_standing_order');
  assert.equal(decideMemoryAdmission(candidate({ evidenceRefs: ['missing'] }), {
    resolvableRefs: ['ev-1'],
  }).reason, 'evidence_unresolved');
});

test('推断偏好不满 3 个 episode 不生效，满 3 个才生效', () => {
  const early = decideMemoryAdmission(candidate({
    kind: 'preference',
    trust: 'inferred',
    text: '回复要短',
    evidenceRefs: [],
  }), { episodeIds: ['ep-1', 'ep-2'] });
  assert.equal(early.decision, 'candidate');
  assert.equal(early.reason, 'preference_unconfirmed');
  assert.equal(early.confirmedCount, 2);
  const ready = decideMemoryAdmission(candidate({
    kind: 'preference',
    trust: 'inferred',
    text: '回复要短',
    evidenceRefs: [],
  }), { episodeIds: ['ep-1', 'ep-2', 'ep-3'] });
  assert.equal(ready.decision, 'activate');
  assert.equal(ready.reason, 'inferred_preference');
});

test('关闭学习偏好只拒绝推断偏好，已验证事实仍可生效', () => {
  assert.equal(decideMemoryAdmission(candidate({
    kind: 'preference',
    trust: 'inferred',
    text: '回复要短',
    evidenceRefs: [],
  }), { learnPreferences: false, episodeIds: ['ep-1', 'ep-2', 'ep-3'] }).reason, 'preferences_disabled');
  assert.equal(decideMemoryAdmission(candidate(), {
    learnPreferences: false,
    resolvableRefs: ['ev-1'],
    evidenceTexts: { 'ev-1': '登录页在 src/login.tsx' },
  }).decision, 'activate');
  assert.equal(decideMemoryAdmission(candidate({ text: '数据库在别的仓库' }), {
    resolvableRefs: ['ev-1'],
    evidenceTexts: { 'ev-1': '登录页在 src/login.tsx' },
  }).reason, 'evidence_unsupported');
});

test('与项目指令冲突的候选不生效，坏 JSON 被丢弃', () => {
  assert.equal(decideMemoryAdmission(candidate({
    kind: 'preference',
    trust: 'inferred',
    text: '回复要短',
    evidenceRefs: [],
  }), { contradicts: ['回复要短'], episodeIds: ['ep-1', 'ep-2', 'ep-3'] }).reason, 'instruction_conflict');
  const parsed = parseCuratorOutput('```json\n{"candidates":[{"kind":"nope"},{"kind":"fact","trust":"verified","text":"登录页在 src/login.tsx","evidenceRefs":["ev-1"]}]}\n```');
  assert.equal(parsed.discarded.length, 1);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].text, '登录页在 src/login.tsx');
  assert.deepEqual(parseCuratorOutput('not json').discarded, [{ reason: 'invalid_json' }]);
});
