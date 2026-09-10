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
    // Regression guard: `no-referrer` turns the page into an opaque origin and
    // makes the login form POST send `Origin: null`, which the server rejects
    // with 403 ORIGIN_DENIED. See dump-login-headers evidence in the plan.
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    assert.notEqual(response.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal(remoteWebResponse('/unknown'), null);
});

test('login form is a plain same-origin POST that the Origin check accepts', async () => {
  // The form must not gain a crossorigin/opaque context, and its target must
  // stay on this origin, otherwise the browser sends `Origin: null`.
  const html = await remoteWebResponse('/').text();
  assert.match(html, /<form id="login" action="\/auth\/login" method="post"[^>]*>/);
  assert.doesNotMatch(html, /<form[^>]*crossorigin/);
  assert.doesNotMatch(html, /<form[^>]*target="_blank"/);
});

test('CSP form-action covers the identity provider redirect hop', async () => {
  // Regression guard: `form-action` is re-checked on the redirect hop of a form
  // submission. The login POST 303s to the issuer, so a CSP of only `'self'`
  // silently cancels that hop when the issuer is on another origin (a different
  // port counts), leaving the browser stuck on the login form.
  const handle = createAccountHttp({
    origin: 'https://peer.example',
    login: { issuer: 'https://id.peer.example:8443' },
    sessions: {},
    devices: {},
  });
  const csp = (await handle(new Request('https://peer.example/'))).headers.get('content-security-policy');
  assert.match(csp, /form-action 'self' https:\/\/id\.peer\.example:8443;/);
});

test('CSP form-action stays minimal when the issuer shares the surface origin', async () => {
  const sameOrigin = createAccountHttp({
    origin: 'https://peer.example',
    login: { issuer: 'https://peer.example' },
    sessions: {},
    devices: {},
  });
  const csp = (await sameOrigin(new Request('https://peer.example/'))).headers.get('content-security-policy');
  assert.match(csp, /form-action 'self';/);
  assert.doesNotMatch(csp, /form-action 'self' https:\/\/peer\.example/);
});

test('CSP form-action degrades safely without a usable issuer', async () => {
  for (const login of [{}, { issuer: 'not-a-url' }, { issuer: undefined }]) {
    const handle = createAccountHttp({ origin: 'https://peer.example', login, sessions: {}, devices: {} });
    const csp = (await handle(new Request('https://peer.example/'))).headers.get('content-security-policy');
    assert.match(csp, /form-action 'self';/);
  }
});

test('remoteWebResponse lists extra form-action origins and ignores junk', async () => {
  const response = await remoteWebResponse('/devices', {
    formActionOrigins: ['https://id.example:8443', '', null, undefined],
  });
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /form-action 'self' https:\/\/id\.example:8443;/);
  assert.doesNotMatch(csp, /form-action 'self' {2}/);
  assert.equal((await remoteWebResponse('/')).headers.get('content-security-policy').includes("form-action 'self';"), true);
});
