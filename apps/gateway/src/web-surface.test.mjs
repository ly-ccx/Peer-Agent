import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { remoteWebResponse } from './web-surface.mjs';
import { createAccountHttp } from './account-http.mjs';

for (const state of ['anonymous', 'bound', 'revoked', 'unavailable']) {
  test(`web-device-state-${state}`, async () => {
    const nodes = new Map();
    const element = () => ({ hidden: false, textContent: '', children: [], listeners: {},
      replaceChildren() { this.children = []; }, append(...values) { this.children.push(...values); },
      addEventListener(name, fn) { this.listeners[name] = fn; } });
    const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
    const calls = [];
    const fetch = async (url, options) => {
      calls.push([url, options]);
      if (url === '/auth/logout') return { ok: true };
      return { status: state === 'anonymous' ? 401 : state === 'unavailable' ? 503 : 200,
        ok: !['anonymous', 'unavailable'].includes(state),
        json: async () => ({ devices: [{ name: '<img src=x onerror=alert(1)>', online: true, revoked: state === 'revoked' }] }) };
    };
    runInNewContext(await remoteWebResponse('/assets/remote.js').text(), { document, fetch });
    await new Promise(resolve => setImmediate(resolve));
    if (state === 'anonymous') {
      assert.equal(nodes.get('login').hidden, false);
      assert.equal(nodes.get('devices').children.length, 0);
    } else if (state === 'unavailable') assert.match(nodes.get('status').textContent, /无法获取/);
    else {
      const card = nodes.get('devices').children[0];
      assert.equal(card.children[0].textContent, '<img src=x onerror=alert(1)>');
      assert.match(card.children[1].textContent, state === 'revoked' ? /已撤销/ : /执行权限尚未接入/);
      await nodes.get('logout').listeners.click();
      assert.equal(nodes.get('devices').children.length, 0);
      assert.match(nodes.get('status').textContent, /设备绑定与本机服务不受影响/);
      assert.equal(calls.at(-1)[1].method, 'POST');
    }
  });
}

test('HTTP serves static shell with restrictive CSP and no identity lookup', async () => {
  const handle = createAccountHttp({ origin: 'https://peer.example', login: {}, sessions: {}, devices: {} });
  for (const path of ['/', '/devices', '/assets/remote.js']) {
    const response = await handle(new Request('https://peer.example' + path));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(remoteWebResponse('/unknown'), null);
});
