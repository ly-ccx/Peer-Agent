import assert from 'node:assert/strict';
import test from 'node:test';
import { computeViewportPoint } from './local-browser-control-provider.mjs';

test('computeViewportPoint 保留逻辑坐标（契约：统一逻辑坐标）', () => {
  const result = computeViewportPoint({ x: 100, y: 50 }, {});
  assert.equal(result.x, 100);
  assert.equal(result.y, 50);
  assert.equal(result.css.x, 100);
  assert.equal(result.css.y, 50);
  // 默认 dpr=1, scale=1, scroll=0
  assert.equal(result.dpr, 1);
  assert.equal(result.visualViewportScale, 1);
  assert.deepEqual(result.scroll, { x: 0, y: 0 });
});

test('computeViewportPoint 记录 dpr 但不放大坐标（架构契约）', () => {
  const result = computeViewportPoint({ x: 100, y: 50 }, { devicePixelRatio: 2 });
  // 契约：不对 x/y 做物理放大，底层处理 scaleFactor
  assert.equal(result.x, 100);
  assert.equal(result.y, 50);
  assert.equal(result.dpr, 2);
});

test('computeViewportPoint 记录 visualViewport.scale 但不放大坐标', () => {
  const result = computeViewportPoint({ x: 100, y: 50 }, { visualViewportScale: 1.25 });
  assert.equal(result.x, 100);
  assert.equal(result.y, 50);
  assert.equal(result.visualViewportScale, 1.25);
});

test('computeViewportPoint 记录 scroll 偏移', () => {
  const result = computeViewportPoint({ x: 100, y: 50 }, { scrollX: 200, scrollY: -30 });
  assert.equal(result.scroll.x, 200);
  assert.equal(result.scroll.y, -30);
  // 坐标本身仍保留逻辑值
  assert.equal(result.x, 100);
  assert.equal(result.y, 50);
});

test('computeViewportPoint 非法/缺省视口字段回落默认', () => {
  const result = computeViewportPoint({ x: 10, y: 20 }, {
    devicePixelRatio: 0,
    visualViewportScale: NaN,
    scrollX: Infinity,
    scrollY: undefined,
  });
  assert.equal(result.dpr, 1);
  assert.equal(result.visualViewportScale, 1);
  assert.equal(result.scroll.x, 0);
  assert.equal(result.scroll.y, 0);
  assert.equal(result.x, 10);
  assert.equal(result.y, 20);
});

test('computeViewportPoint 坐标四舍五入为整数', () => {
  const result = computeViewportPoint({ x: 100.4, y: 50.6 }, {});
  assert.equal(result.x, 100);
  assert.equal(result.y, 51);
  assert.equal(result.css.x, 100);
  assert.equal(result.css.y, 51);
});
