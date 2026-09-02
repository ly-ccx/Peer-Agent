import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFrameSelector, buildElementJs, buildRolesSnapshotJs, buildRoleResolveJs, buildTextTestIdResolveJs, ELEMENT_ACTIONABLE_SAMPLE_BODY, describeActionableWaitFailure } from './local-browser-control-provider.mjs';

test('parseFrameSelector 无前缀时返回空 framePath 与原始 css', () => {
  const r = parseFrameSelector('#submit');
  assert.deepEqual(r.framePath, []);
  assert.equal(r.css, '#submit');
});

test('parseFrameSelector 解析 frame:0 前缀', () => {
  const r = parseFrameSelector('frame:0 #submit');
  assert.deepEqual(r.framePath, [0]);
  assert.equal(r.css, '#submit');
});

test('parseFrameSelector 解析 frame:1 + 多词 css', () => {
  const r = parseFrameSelector('frame:1 .btn.primary > span');
  assert.deepEqual(r.framePath, [1]);
  assert.equal(r.css, '.btn.primary > span');
});

test('parseFrameSelector 空/undefined 安全回落', () => {
  assert.deepEqual(parseFrameSelector('').framePath, []);
  assert.equal(parseFrameSelector('').css, '');
  assert.deepEqual(parseFrameSelector(undefined).framePath, []);
  assert.equal(parseFrameSelector(undefined).css, '');
});

test('buildElementJs 无前缀生成主 document 查询表达式', () => {
  const js = buildElementJs('#submit');
  assert.ok(js.includes('let doc = document;'));
  assert.ok(js.includes('function queryDeep(root, css)'));
  assert.ok(js.includes('queryDeep(doc, "#submit")'));
  assert.ok(js.includes('node.shadowRoot'));
  assert.ok(js.includes('if (!el) return null;'));
});

test('buildElementJs 带 frame:1 下钻到对应 iframe document', () => {
  const js = buildElementJs('frame:1 .btn');
  assert.ok(js.includes('doc.defaultView?.frames[1]?.document || null'));
  assert.ok(js.includes('queryDeep(doc, ".btn")'));
});

test('buildElementJs 未命中/下钻失败返回 null', () => {
  const js = buildElementJs('frame:99 #x');
  assert.ok(js.includes('if (!doc) return null;'));
  assert.ok(js.includes('if (!el) return null;'));
});

test('buildElementJs 注入 body 并在定位后执行', () => {
  const js = buildElementJs('#box', 'return el.offsetWidth;');
  assert.ok(js.includes('return el.offsetWidth;'));
  assert.ok(js.includes('const el = queryDeep(doc, "#box");'));
});

test('buildElementJs 对 selector 做 JSON 转义防注入', () => {
  const js = buildElementJs(`#x"}; return 1; //`);
  assert.ok(js.includes(JSON.stringify(`#x"}; return 1; //`)));
  // 不应出现裸的未转义引号拼接成可执行语句
  assert.ok(!js.includes(`querySelector(#x"`) );
});

test('buildRolesSnapshotJs 无 selector 时扫 document.body', () => {
  const js = buildRolesSnapshotJs();
  assert.ok(js.includes('const root = doc.body || doc.documentElement'));
  assert.ok(js.includes('collectRoles(root, doc, IMPLICIT, INPUT_ROLES, NAME_MAX, MAX)'));
  assert.ok(js.includes('"BUTTON":"button"') || js.includes('"BUTTON": "button"'));
});

test('buildRolesSnapshotJs 支持 frame:N 前缀与 selector 转义', () => {
  const js = buildRolesSnapshotJs('frame:0 #panel"};alert(1)');
  assert.ok(js.includes('frames[0]'));
  assert.ok(js.includes('queryDeep(doc, ' + JSON.stringify('#panel"};alert(1)') + ')'));
  assert.ok(js.includes('current.shadowRoot'));
  assert.ok(!js.includes('querySelector(#panel"}'));
});

test('buildRoleResolveJs requires a unique role/name match and reuses snapshot helpers', () => {
  const js = buildRoleResolveJs('button', 'Submit', 'return { ok: true, count: 1 };');
  assert.ok(js.includes('findRoleMatches'));
  assert.ok(js.includes('accessibleName'));
  assert.ok(js.includes('nameMatches'));
  assert.ok(js.includes('"button"'));
  assert.ok(js.includes('"Submit"'));
  assert.ok(js.includes('const wantNth = null;'));
  assert.ok(js.includes('if (matches.length !== 1) return { ok: false, count: matches.length }'));
});

test('buildRoleResolveJs selects the nth match when provided', () => {
  const js = buildRoleResolveJs('button', 'OK', 'return { ok: true, count: 1 };', { nth: 0 });
  assert.ok(js.includes('const wantNth = 0;'));
  assert.ok(js.includes('wantNth >= matches.length'));
  assert.ok(js.includes('matches[wantNth]'));
});

test('buildTextTestIdResolveJs matches visible text or data-testid and supports nth', () => {
  const textJs = buildTextTestIdResolveJs('hasText', 'Submit', 'return { ok: true, count: 1 };');
  assert.ok(textJs.includes('findTextTestIdMatches'));
  assert.ok(textJs.includes('visibleTextOf'));
  assert.ok(textJs.includes('"hasText"'));
  assert.ok(textJs.includes('"Submit"'));
  assert.ok(textJs.includes('const wantNth = null;'));
  const testIdJs = buildTextTestIdResolveJs('testid', 'login-btn', 'return { ok: true, count: 1 };', { nth: 1 });
  assert.ok(testIdJs.includes('"testid"'));
  assert.ok(testIdJs.includes('"login-btn"'));
  assert.ok(testIdJs.includes('data-testid'));
  assert.ok(testIdJs.includes('const wantNth = 1;'));
});

test('actionable wait sample checks enabled, occlusion, and stale nodes', () => {
  assert.ok(ELEMENT_ACTIONABLE_SAMPLE_BODY.includes('elementFromPoint'));
  assert.ok(ELEMENT_ACTIONABLE_SAMPLE_BODY.includes('isConnected'));
  assert.ok(ELEMENT_ACTIONABLE_SAMPLE_BODY.includes("reason: 'disabled'"));
  assert.ok(ELEMENT_ACTIONABLE_SAMPLE_BODY.includes("reason: 'occluded'"));
  assert.ok(ELEMENT_ACTIONABLE_SAMPLE_BODY.includes("reason: 'stale'"));
  assert.equal(describeActionableWaitFailure('disabled', false, 'click'), 'Target stayed disabled; did not click.');
  assert.equal(describeActionableWaitFailure('occluded', false, 'hover'), 'Target stayed covered; did not hover.');
  assert.equal(describeActionableWaitFailure('stale', false, 'type'), 'Target node was detached; did not type.');
});
