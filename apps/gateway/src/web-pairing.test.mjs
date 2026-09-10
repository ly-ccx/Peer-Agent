import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { remoteWebResponse } from './web-surface.mjs';

for (const loggedIn of [false, true]) {
  for (const outcome of [202, 400, 401, 429]) {
    test(`web-pairing-login-${loggedIn}-response-${outcome}`, async () => {
      const nodes = new Map();
      const element = () => ({ hidden: true, disabled: false, value: '', textContent: '', children: [], listeners: {},
        replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
        addEventListener(event, callback) { this.listeners[event] = callback; } });
      const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
      let claims = 0; let finish;
      const fetch = async (url, options) => {
        if (url === '/api/devices') return { status: loggedIn ? 200 : 401, ok: loggedIn, json: async () => ({ devices: [] }) };
        assert.equal(url, '/api/pairings/claim'); claims++;
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { challengeId: 'challenge', pairingKey: 'secret' });
        return new Promise(resolve => { finish = () => resolve({ status: outcome }); });
      };
      runInNewContext(await remoteWebResponse('/assets/remote.js').text(), { document, fetch });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(nodes.get('pairing').hidden, !loggedIn);
      nodes.get('challenge').value = ' challenge '; nodes.get('pairing-key').value = 'secret';
      const submit = nodes.get('pairing').listeners.submit;
      const first = submit({ preventDefault() {} });
      await submit({ preventDefault() {} });
      assert.equal(claims, loggedIn ? 1 : 0, 'no anonymous or duplicate submit');
      if (loggedIn) {
        assert.equal(nodes.get('pairing-key').value, '');
        finish();
      }
      await first;
      if (loggedIn && outcome === 202) assert.match(nodes.get('pairing-status').textContent, /等待本机/);
      if (loggedIn && outcome === 400) assert.match(nodes.get('pairing-status').textContent, /无效/);
      if (loggedIn && outcome === 429) assert.match(nodes.get('pairing-status').textContent, /频繁/);
      if (loggedIn && outcome === 401) {
        assert.equal(nodes.get('pairing').hidden, true);
        assert.equal(nodes.get('login').hidden, false);
      }
      assert.equal(nodes.get('claim').disabled, false);
    });
  }
}
