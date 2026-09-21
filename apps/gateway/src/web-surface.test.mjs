import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { remoteWebResponse } from './web-surface.mjs';
import { createAccountHttp } from './account-http.mjs';

/** Declarations only: prose in comments must not be mistaken for real CSS. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

for (const state of ['anonymous', 'bound', 'revoked', 'unavailable']) {
  test(`web-device-state-${state}`, async () => {
    const nodes = new Map();
    const element = () => ({ hidden: false, textContent: '', children: [], listeners: {},
      replaceChildren(...values) { this.children = [...values]; }, append(...values) { this.children.push(...values); },
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

test('stylesheet is served as its own same-origin asset', async () => {
  const response = await remoteWebResponse('/assets/remote.css');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /:root\s*\{/);
  assert.equal(remoteWebResponse('/assets/remote.pcss'), null);
});

test('CSP allows the stylesheet without relaxing anything else', async () => {
  // `default-src 'none'` blocks the stylesheet, so the surface must opt in.
  // It must not opt into inline styles while doing so.
  const handle = createAccountHttp({ origin: 'https://peer.example', login: {}, sessions: {}, devices: {} });
  const csp = (await handle(new Request('https://peer.example/'))).headers.get('content-security-policy');
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('page links the stylesheet instead of inlining style', async () => {
  const html = await remoteWebResponse('/').text();
  assert.match(html, /<link rel="stylesheet" href="\/assets\/remote\.css">/);
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /\sstyle="/);
});

test('[hidden] survives the layout rules', async () => {
  // Author `display` rules outrank the UA `[hidden]` rule. Without the guard the
  // login form, logout button and pairing panel would all be visible at once,
  // which is exactly the show/hide state machine the script drives.
  const css = stripComments(await remoteWebResponse('/assets/remote.css').text());
  const guard = /\[hidden\]\s*\{\s*display:\s*none\s*!important/.exec(css);
  assert.ok(guard, '[hidden] guard missing or not !important');
  for (const selector of ['.panel {', '.devices {', '.actions {']) {
    assert.ok(css.indexOf(selector) > guard.index, selector + ' must be declared after the [hidden] guard');
  }
});

test('dark palette is provided rather than an inverted light one', async () => {
  const css = await remoteWebResponse('/assets/remote.css').text();
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /--canvas:\s*#11141A/);
  assert.match(css, /--ink:\s*#EDF1F6/);
});

test('device state carries a class hook and a sentence, never colour alone', async () => {
  const seen = [];
  for (const [online, revoked] of [[true, false], [false, false], [true, true]]) {
    const nodes = new Map();
    const element = () => ({ hidden: false, textContent: '', className: '', children: [], listeners: {},
      replaceChildren(...values) { this.children = [...values]; }, append(...values) { this.children.push(...values); },
      addEventListener(name, fn) { this.listeners[name] = fn; } });
    const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
    const fetch = async () => ({ status: 200, ok: true, json: async () => ({ devices: [{ name: 'mac-mini', online, revoked }] }) });
    runInNewContext(await remoteWebResponse('/assets/remote.js').text(), { document, fetch });
    await new Promise(resolve => setImmediate(resolve));
    const state = nodes.get('devices').children[0].children[1];
    seen.push({ cls: state.className, text: state.textContent });
  }
  assert.match(seen[0].cls, /state-online/);
  assert.match(seen[1].cls, /state-offline/);
  assert.match(seen[2].cls, /state-revoked/);
  assert.match(seen[2].text, /已撤销绑定/);
  for (const entry of seen) {
    assert.ok(entry.text.trim().length > 0, 'state must read without colour: ' + JSON.stringify(entry));
  }
});

test('Peer Frost red lines hold in the stylesheet', async () => {
  const css = stripComments(await remoteWebResponse('/assets/remote.css').text());

  // Red line 1: azure never on a CTA — the primary control is graphite-on-paper.
  const primary = /\.btn-primary\s*\{[^}]*\}/.exec(css)[0];
  assert.match(primary, /background:\s*var\(--ink\)/);
  assert.doesNotMatch(primary, /--seal/);

  // Red line 2: the H1 floor stays at 30px or larger.
  assert.match(/h1\s*\{[^}]*\}/.exec(css)[0], /clamp\(30px/);

  // Red line 3: one sans family, no serif reintroduced for headings.
  assert.match(css, /--font-sans:/);
  assert.doesNotMatch(css, /--font-serif/);

  // Red line 5: no pure black, and no pure white (near-white canvas only).
  assert.doesNotMatch(css, /#000000|#000\b|#FFFFFF|#FFF\b/i);

  // Red line 7: the shadow budget is unused — boundaries are hairlines.
  assert.doesNotMatch(css, /box-shadow/);

  // Red line 8: every numeric radius stays within 16px.
  for (const [, px] of css.matchAll(/border-radius:\s*(\d+)px/g)) {
    assert.ok(Number(px) <= 16, 'border-radius ' + px + 'px exceeds the 16px red line');
  }
});

function createScriptHarness(fetch) {
  const nodes = new Map();
  const element = () => ({ hidden: false, textContent: '', value: '', className: '', children: [], listeners: {},
    replaceChildren(...values) { this.children = [...values]; }, append(...values) { this.children.push(...values); },
    addEventListener(name, fn) { this.listeners[name] = fn; } });
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, createElement: element };
  return { nodes, document, element };
}

test('登录后出现只读任务入口，工作区来自委派投影，提交后展示结果', async () => {
  const harness = createScriptHarness();
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push([url, options]);
    if (url === '/api/devices') return { status: 200, ok: true, json: async () => ({ devices: [{ name: 'Mac', online: true }] }) };
    if (url === '/api/delegations') return { status: 200, ok: true,
      json: async () => ({ delegations: [{ deviceId: 'device-1', name: 'Mac', delegation: { workspaceIds: ['ws-1'] } }] }) };
    if (url === '/api/tasks/read') return { status: 200, ok: true,
      json: async () => ({ requestId: 'req-1', status: 'ok', result: { taskId: 'task-9', state: 'running' } }) };
    throw new Error('unexpected ' + url);
  };
  runInNewContext(await remoteWebResponse('/assets/remote.js').text(), { document: harness.document, fetch });
  const waitFor = async (check) => {
    const end = Date.now() + 500;
    while (!check()) {
      if (Date.now() > end) throw new Error('TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await waitFor(() => harness.nodes.get('task-device')?.children.length > 0);
  // 工作区只能来自本机上报的投影，页面不得自行编造。
  assert.deepEqual(harness.nodes.get('task-device').children.map(option => option.value), ['device-1']);
  assert.deepEqual(harness.nodes.get('task-workspace').children.map(option => option.value), ['ws-1']);
  harness.nodes.get('task-id').value = 'task-9';
  harness.nodes.get('task-device').value = 'device-1';
  harness.nodes.get('task-workspace').value = 'ws-1';
  await harness.nodes.get('task-read').listeners.submit({ preventDefault() {} });
  const call = calls.find(([url]) => url === '/api/tasks/read');
  assert.deepEqual(JSON.parse(call[1].body), { deviceId: 'device-1', workspaceId: 'ws-1', taskId: 'task-9' });
  assert.match(harness.nodes.get('task-result').textContent, /running/);
  assert.match(harness.nodes.get('task-result').className, /task-result-ok/);
});

test('没有可用委派时不显示只读任务入口', async () => {
  const harness = createScriptHarness();
  const fetch = async url => {
    if (url === '/api/devices') return { status: 200, ok: true, json: async () => ({ devices: [{ name: 'Mac', online: false }] }) };
    if (url === '/api/delegations') return { status: 200, ok: true, json: async () => ({ delegations: [] }) };
    throw new Error('unexpected ' + url);
  };
  runInNewContext(await remoteWebResponse('/assets/remote.js').text(), { document: harness.document, fetch });
  const end = Date.now() + 500;
  while (harness.nodes.get('devices')?.children.length !== 1 && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(harness.nodes.get('task-read').hidden, true, '无委派投影时入口必须保持隐藏');
});

test('读取失败时给出人话解释，而不是裸错误码', async () => {
  const harness = createScriptHarness();
  const fetch = async (url, options = {}) => {
    if (url === '/api/devices') return { status: 200, ok: true, json: async () => ({ devices: [{ name: 'Mac', online: true }] }) };
    if (url === '/api/delegations') return { status: 200, ok: true,
      json: async () => ({ delegations: [{ deviceId: 'device-1', name: 'Mac', delegation: { workspaceIds: ['ws-1'] } }] }) };
    if (url === '/api/tasks/read') return { status: 504, ok: false, json: async () => ({ error: 'TASK_UNAVAILABLE', code: 'OUTCOME_UNKNOWN' }) };
    throw new Error('unexpected ' + url);
  };
  runInNewContext(await remoteWebResponse('/assets/remote.js').text(), { document: harness.document, fetch });
  const waitFor = async (check) => {
    const end = Date.now() + 500;
    while (!check()) {
      if (Date.now() > end) throw new Error('TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await waitFor(() => harness.nodes.get('task-device')?.children.length > 0);
  await harness.nodes.get('task-read').listeners.submit({ preventDefault() {} });
  await waitFor(() => harness.nodes.get('task-result').textContent.includes('读取未完成'));
  const text = harness.nodes.get('task-result').textContent;
  assert.match(text, /结果未知/, '超时必须说清是未知，而不是失败或完成');
  assert.match(harness.nodes.get('task-result').className, /task-result-alert/);
});
