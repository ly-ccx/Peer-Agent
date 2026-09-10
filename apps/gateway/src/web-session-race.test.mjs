import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { remoteWebResponse } from './web-surface.mjs';

for (const pending of ['refresh', 'pairing']) {
  for (const success of [true, false]) {
    test(`web-logout-pending-${pending}-success-${success}`, async () => {
      const nodes = new Map();
      const element = () => ({ hidden: true, disabled: false, value: '', textContent: '', children: [], listeners: {},
        replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
        addEventListener(event, callback) { this.listeners[event] = callback; } });
      const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
      const calls = []; let finishPending; let finishLogout;
      const list = () => ({ status: 200, ok: true, json: async () => ({ devices: [{ name: 'Mac', online: true }] }) });
      const fetch = async url => {
        calls.push(url);
        if (calls.length === 1) return list();
        if (url === '/auth/logout') return new Promise(resolve => { finishLogout = () => resolve({ ok: success }); });
        return new Promise(resolve => { finishPending = () => resolve(pending === 'refresh' ? list() : { status: 202 }); });
      };
      runInNewContext(await remoteWebResponse('/assets/remote.js').text(), { document, fetch });
      await new Promise(resolve => setImmediate(resolve));
      nodes.get('challenge').value = 'challenge'; nodes.get('pairing-key').value = 'secret';
      const inFlight = pending === 'refresh' ? nodes.get('refresh').listeners.click()
        : nodes.get('pairing').listeners.submit({ preventDefault() {} });
      const logout = nodes.get('logout').listeners.click();
      await nodes.get('refresh').listeners.click();
      await nodes.get('logout').listeners.click();
      assert.equal(calls.length, 3, 'no refresh or duplicate logout during logout');
      assert.equal(nodes.get('pairing-key').value, '');
      assert.equal(nodes.get('challenge').value, '');
      finishLogout(); await logout;
      const message = nodes.get('status').textContent;
      finishPending(); await inFlight;
      assert.equal(nodes.get('status').textContent, message);
      assert.match(message, success ? /已退出/ : /退出未确认/);
      assert.equal(nodes.get('pairing').hidden, true);
      assert.equal(nodes.get('pairing-status').textContent, '');
      assert.equal(nodes.get('devices').children.length, 0);
      assert.equal(nodes.get('refresh').disabled, false);
      await nodes.get('pairing').listeners.submit({ preventDefault() {} });
      assert.equal(calls.length, 3, 'stale responses do not reauthorize submission');
    });
  }
}
