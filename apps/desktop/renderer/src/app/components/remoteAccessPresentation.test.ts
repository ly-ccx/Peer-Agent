import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionSummary, describeFailure } from './remoteAccessPresentation.ts';

test('配对超时给出可操作提示，而不是裸露的 timeout', () => {
  // Regression: the panel looked hints up by failure.code only, so supervisor
  // categories (which carry no code) fell through to the raw reason. The pairing
  // window closing is the failure users hit most, and it read as bare "timeout".
  const text = describeFailure({ reason: 'timeout' });
  assert.match(text, /认领超时/);
  assert.match(text, /重新获取/, '必须说明怎么恢复');
  assert.doesNotMatch(text, /^timeout$/, '不得只显示内部 token');
});

test('连接断开给出可操作提示，而不是裸露的 disconnected', () => {
  const text = describeFailure({ reason: 'disconnected' });
  assert.match(text, /断开/);
  assert.doesNotMatch(text, /^disconnected$/);
});

test('传输错误码优先于分类，且保留原始码', () => {
  // The code names the root cause precisely; the category is only a fallback.
  const text = describeFailure({ reason: 'transport_failure', code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  assert.match(text, /^\[SELF_SIGNED_CERT_IN_CHAIN\]/, '原始错误码必须保留，否则用户无法自查');
  assert.match(text, /证书/);
});

test('带码但无已知提示时回落到 message', () => {
  const text = describeFailure({ reason: 'transport_failure', code: 'WEIRD_CODE', message: 'socket exploded' });
  assert.equal(text, '[WEIRD_CODE] socket exploded');
});

test('完全未知的分类退化为 reason 本身，不显示空字符串', () => {
  const text = describeFailure({ reason: 'brand_new_reason' });
  assert.equal(text, 'brand_new_reason');
});

test('等待认领时状态行显示「等待认领」，不误报为连接中', () => {
  const base = { settings: { enabled: true, gatewayOrigin: '', workspaceId: '' }, active: true, online: false, deviceId: null, connectionEpoch: 0 };
  assert.equal(
    connectionSummary({ ...base, pairing: { challengeId: 'c', pairingKey: 'k', deviceId: 'd', expiresAt: Date.now() + 1000 } }),
    '等待认领',
  );
});

test('连接失败时状态行显示「连接失败」，不显示「正在连接…」', () => {
  const base = { settings: { enabled: true, gatewayOrigin: '', workspaceId: '' }, active: true, online: false, deviceId: null, connectionEpoch: 0 };
  assert.equal(connectionSummary({ ...base, lastFailure: { reason: 'timeout' } }), '连接失败');
});

test('在线时状态行显示已连接并带设备号', () => {
  const base = { settings: { enabled: true, gatewayOrigin: '', workspaceId: '' }, active: true, online: true, deviceId: 'dev-1', connectionEpoch: 3 };
  assert.equal(connectionSummary(base), '已连接 (dev-1)');
});

test('既无失败也未连接时，按是否活动区分连接中与未连接', () => {
  const base = { settings: { enabled: true, gatewayOrigin: '', workspaceId: '' }, online: false, deviceId: null, connectionEpoch: 0 };
  assert.equal(connectionSummary({ ...base, active: true }), '正在连接…');
  assert.equal(connectionSummary({ ...base, active: false }), '未连接');
});
