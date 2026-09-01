import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFrameSelector, buildElementJs } from './local-browser-control-provider.mjs';

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
  assert.ok(js.includes('doc.querySelector("#submit")'));
  assert.ok(js.includes('if (!el) return null;'));
});

test('buildElementJs 带 frame:1 下钻到对应 iframe document', () => {
  const js = buildElementJs('frame:1 .btn');
  assert.ok(js.includes('doc.defaultView?.frames[1]?.document || null'));
  assert.ok(js.includes('doc.querySelector(".btn")'));
});

test('buildElementJs 未命中/下钻失败返回 null', () => {
  const js = buildElementJs('frame:99 #x');
  assert.ok(js.includes('if (!doc) return null;'));
  assert.ok(js.includes('if (!el) return null;'));
});

test('buildElementJs 注入 body 并在定位后执行', () => {
  const js = buildElementJs('#box', 'return el.offsetWidth;');
  assert.ok(js.includes('return el.offsetWidth;'));
  assert.ok(js.includes('const el = doc.querySelector("#box");'));
});

test('buildElementJs 对 selector 做 JSON 转义防注入', () => {
  const js = buildElementJs(`#x"}; return 1; //`);
  assert.ok(js.includes(JSON.stringify(`#x"}; return 1; //`)));
  // 不应出现裸的未转义引号拼接成可执行语句
  assert.ok(!js.includes(`querySelector(#x"`) );
});
