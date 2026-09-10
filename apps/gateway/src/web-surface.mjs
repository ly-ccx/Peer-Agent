const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Peer · 远程设备</title>
<link rel="stylesheet" href="/assets/remote.css"></head>
<body><div class="shell">
<header class="masthead"><div class="brand"><span class="seal" aria-hidden="true"></span><div>
<h1>远程设备</h1>
<p class="lede">登录后查看你绑定的电脑。本地使用 Peer 无需登录。</p>
</div></div>
<div class="actions">
<form id="login" action="/auth/login" method="post" hidden><button type="submit" class="btn-primary">登录 Peer</button></form>
<button id="refresh" type="button" class="btn-quiet">刷新设备</button>
<button id="logout" type="button" class="btn-quiet" hidden>退出当前登录</button>
</div></header>
<p id="status" class="status" role="status">正在检查登录状态…</p>
<section id="devices" class="devices" aria-label="设备列表"></section>
<form id="pairing" class="panel" hidden><h2>添加设备</h2>
<p class="panel-note">从本机 Peer 取得配对信息。当前开发版本需要挑战 ID 和一次性 Key，请勿转发。</p>
<div class="field"><label for="challenge">挑战 ID</label><input id="challenge" required maxlength="128" autocomplete="off"></div>
<div class="field"><label for="pairing-key">一次性 Key</label><input id="pairing-key" type="password" required maxlength="256" autocomplete="off"></div>
<div class="actions"><button id="claim" type="submit" class="btn-primary">绑定设备</button></div>
<p id="pairing-status" class="pairing-status" role="status"></p></form>
<form id="task-read" class="panel" hidden><h2>读取本机任务</h2>
<p class="panel-note">只读：查看该任务在本机的当前状态，不提交任何修改。任务始终属于某台设备与某个工作区。</p>
<div class="field"><label for="task-device">设备</label><select id="task-device"></select></div>
<div class="field"><label for="task-workspace">工作区</label><select id="task-workspace"></select></div>
<div class="field"><label for="task-id">任务 ID</label><input id="task-id" required maxlength="128" autocomplete="off"></div>
<div class="actions"><button id="task-submit" type="submit" class="btn-primary">读取状态</button></div>
<p id="task-result" class="task-result" role="status"></p></form>
<p class="footnote">在线仅代表连接可用；读取结果由本机判定。当前版本不开放任何写入操作。</p>
</div><script src="/assets/remote.js" defer></script></body></html>`;

/**
 * Peer Frost stylesheet for the remote surface.
 *
 * Served as its own asset so the page needs no inline style: the CSP stays
 * `default-src 'none'` and only gains `style-src 'self'`. Values mirror the
 * Desktop design tokens (apps/desktop/renderer/src/styles/tokens.css) so this
 * reads as the same product, but they are inlined because this file is served
 * standalone by the gateway and cannot import the renderer's stylesheet.
 *
 * Red lines honoured (see tokens.css):
 *   1. azure never on a CTA — the primary button is graphite-on-paper
 *   2. H1 >= 30px — keeps the clamp floor at 30px
 *   3. one sans family for titles and body
 *   4. <= 3 azure marks per screen — only the brand seal and the focus ring
 *   5. no pure black; near-white only on the environment layer
 *   6. state never by colour alone — the dot reinforces a full sentence
 *   7. shadows limited — no shadow is used here, boundaries are hairlines
 *   8. radius <= 16px — 12px cards, 6px controls
 *
 * The Desktop app themes via `[data-theme]`; a standalone page has no such
 * attribute, so the dark palette hangs off prefers-color-scheme instead.
 */

const styles = `/* Critical: any author rule that sets \`display\` outranks the UA \`[hidden]\`
 * rule, which would un-hide the login form, logout button and pairing panel
 * that the script toggles through the \`hidden\` property. Keep this first. */
[hidden] { display: none !important; }

:root {
  color-scheme: light dark;

  /* environment layer: cold near-white, never pure #fff */
  --canvas: #FAFBFC;
  --raised: #F3F5F8;
  --sheet: #F7F9FC;
  --base: #EDF1F6;

  --ink: #1A1D21;
  --ink-soft: #525660;
  --ink-fade: #878B95;
  --ink-mute: #B0B4BC;

  --hairline: #DCE0E8;
  --hairline-soft: #E8ECF1;

  --seal: #3B7FAB;

  --state-success: #3E7A6B;
  --state-warn: #3B6FAB;
  --state-danger: #7A3E50;

  --radius: 12px;
  --radius-sm: 6px;
  --focus: rgba(59, 127, 171, 0.32);

  --font-sans: "Inter", -apple-system, "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", system-ui, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #11141A;
    --raised: #181C24;
    --sheet: #1E232C;
    --base: #1A1E26;

    --ink: #EDF1F6;
    --ink-soft: #B0B4BC;
    --ink-fade: #7B7F8A;
    --ink-mute: #494D58;

    --hairline: #2A303B;
    --hairline-soft: #222834;

    --seal: #5D9CBF;

    --state-success: #6EAA9B;
    --state-warn: #6B9FCB;
    --state-danger: #AA6E80;

    --focus: rgba(93, 156, 191, 0.38);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--canvas);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.6;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
}

.shell {
  max-width: 720px;
  margin: 0 auto;
  padding: clamp(28px, 6vw, 60px) clamp(20px, 5vw, 32px) clamp(36px, 7vw, 64px);
  display: grid;
  gap: clamp(18px, 3vw, 26px);
  align-content: start;
}

.masthead { display: grid; gap: 18px; }

.brand { display: flex; align-items: flex-start; gap: 13px; }

/* Restrained brand mark: a small seal, not a logo. */
.seal {
  flex: none;
  width: 10px;
  height: 10px;
  margin-top: 15px;
  border-radius: 3px;
  background: var(--seal);
}

h1 {
  margin: 0;
  font-size: clamp(30px, 4.6vw, 36px);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.012em;
}

.lede { margin: 6px 0 0; color: var(--ink-soft); font-size: 14px; }

.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }

button {
  font: inherit;
  font-size: 14px;
  font-weight: 550;
  padding: 9px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--hairline);
  background: var(--sheet);
  color: var(--ink);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}

button:hover { background: var(--raised); border-color: var(--ink-mute); }

button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

button:disabled { opacity: 0.5; cursor: default; }

/* Red line 1: the primary control is graphite-on-paper; azure never sits on a
 * CTA. In dark mode the graphite/paper pair inverts with the tokens. */
.btn-primary {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--canvas);
}

.btn-primary:hover { background: var(--ink-soft); border-color: var(--ink-soft); }

.btn-quiet { background: transparent; }

@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}

.status {
  margin: 0;
  padding: 11px 14px;
  border: 1px solid var(--hairline-soft);
  border-radius: var(--radius-sm);
  background: var(--sheet);
  color: var(--ink-soft);
  font-size: 13.5px;
}

/* Tone is decoration on top of the sentence, never the message itself. */
.status-ok { border-color: var(--state-success); }

.status-alert { border-color: var(--state-danger); color: var(--ink); }

.devices { display: grid; gap: 12px; }

/* An emptied list should not leave a gap in the column. */
.devices:empty { display: none; }

.device {
  display: grid;
  gap: 6px;
  padding: 16px 18px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--sheet);
}

.device-revoked { background: var(--base); }

.device-name {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
  /* Device names are user-supplied; let long ones wrap instead of overflowing. */
  overflow-wrap: anywhere;
}

.device-state {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-soft);
  font-size: 13.5px;
}

/* Red line 6: the dot only reinforces the sentence next to it, so the state
 * still reads when colour is unavailable. */
.device-state::before {
  content: "";
  flex: none;
  width: 7px;
  height: 7px;
  /* 50% rather than a large px value: keeps every numeric radius in the file
   * within the "radius <= 16px" red line, which is checked by a test. */
  border-radius: 50%;
  background: var(--ink-mute);
}

.state-online::before { background: var(--state-success); }
.state-offline::before { background: var(--state-warn); }
.state-revoked::before { background: var(--state-danger); }

.panel {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--sheet);
}

.panel h2 { margin: 0; font-size: 17px; font-weight: 600; }

.panel-note { margin: 0; color: var(--ink-soft); font-size: 13.5px; }

.field { display: grid; gap: 5px; }

.field label { font-size: 12.5px; font-weight: 550; color: var(--ink-soft); }

input {
  font: inherit;
  font-size: 14px;
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--canvas);
  color: var(--ink);
}

input:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

/* Native select styled to match the text fields; the OS keeps the menu. */
select {
  font: inherit;
  font-size: 14px;
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--canvas);
  color: var(--ink);
}

select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

.pairing-status { margin: 0; color: var(--ink-soft); font-size: 13px; }

.pairing-status:empty { display: none; }

.task-result { margin: 0; color: var(--ink-soft); font-size: 13px; overflow-wrap: anywhere; }

.task-result:empty { display: none; }

/* Tone reinforces the sentence; the sentence itself always states the outcome. */
.task-result-ok { color: var(--ink); }

.task-result-alert { color: var(--ink); border-left: 2px solid var(--state-danger); padding-left: 8px; }

.footnote {
  margin: 0;
  padding-top: 18px;
  border-top: 1px solid var(--hairline-soft);
  color: var(--ink-fade);
  font-size: 12.5px;
}
`;

const script = `const status = document.getElementById('status');
const devices = document.getElementById('devices');
const login = document.getElementById('login');
const logout = document.getElementById('logout');
const refresh = document.getElementById('refresh');
const pairing = document.getElementById('pairing');
const challenge = document.getElementById('challenge');
const pairingKey = document.getElementById('pairing-key');
const claim = document.getElementById('claim');
const pairingStatus = document.getElementById('pairing-status');
const taskForm = document.getElementById('task-read');
const taskDevice = document.getElementById('task-device');
const taskWorkspace = document.getElementById('task-workspace');
const taskId = document.getElementById('task-id');
const taskSubmit = document.getElementById('task-submit');
const taskResult = document.getElementById('task-result');
let authenticated = false;
let generation = 0;
function setStatus(text, tone) {
  status.textContent = text;
  status.className = tone ? 'status status-' + tone : 'status';
}
async function load() {
  if (logout.disabled) return;
  const current = ++generation;
  devices.replaceChildren();
  setStatus('正在刷新…');
  try {
    const response = await fetch('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
    if (current !== generation) return;
    if (response.status === 401) {
      authenticated = false; pairing.hidden = true; pairingKey.value = '';
      taskForm.hidden = true; taskResult.textContent = '';
      login.hidden = false; logout.hidden = true;
      setStatus('请登录后查看设备。登录过期不会解除设备绑定。'); return;
    }
    if (!response.ok) throw new Error('unavailable');
    const payload = await response.json();
    if (current !== generation) return;
    if (!Array.isArray(payload.devices)) throw new Error('invalid');
    authenticated = true; pairing.hidden = false;
    login.hidden = true; logout.hidden = false;
    void refreshTaskTargets();
    const empty = payload.devices.length === 0;
    setStatus(empty ? '尚未绑定电脑。请在目标电脑发起配对。' : '设备状态已更新', empty ? '' : 'ok');
    for (const device of payload.devices) {
      const card = document.createElement('article');
      card.className = device.revoked ? 'device device-revoked' : 'device';
      const title = document.createElement('h2'); title.textContent = String(device.name ?? '未命名设备');
      title.className = 'device-name';
      const state = document.createElement('p');
      const tone = device.revoked ? 'revoked' : device.online === true ? 'online' : 'offline';
      state.textContent = device.revoked ? '已撤销绑定' : device.online === true ? '在线 · 执行权限尚未接入' : '离线或连接状态未确认';
      state.className = 'device-state state-' + tone;
      card.append(title, state); devices.append(card);
    }
  } catch {
    if (current === generation) setStatus('暂时无法获取设备状态，请重试。', 'alert');
  }
}
logout.addEventListener('click', async () => {
  if (logout.disabled) return;
  ++generation; authenticated = false; pairing.hidden = true; pairingKey.value = '';
  challenge.value = ''; pairingStatus.textContent = '';
  taskForm.hidden = true; taskResult.textContent = ''; taskId.value = '';
  devices.replaceChildren(); logout.disabled = true; refresh.disabled = true;
  try {
    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error('logout failed');
    login.hidden = false; logout.hidden = true;
    setStatus('已退出当前登录。设备绑定与本机服务不受影响。');
  } catch { setStatus('退出未确认，请重试。', 'alert'); }
  finally { logout.disabled = false; refresh.disabled = false; }
});
pairing.addEventListener('submit', async event => {
  event.preventDefault();
  if (!authenticated || claim.disabled) return;
  const current = generation;
  const body = JSON.stringify({ challengeId: challenge.value.trim(), pairingKey: pairingKey.value.trim() });
  pairingKey.value = ''; claim.disabled = true;
  pairingStatus.textContent = '正在认领…';
  try {
    const response = await fetch('/api/pairings/claim', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body });
    if (current !== generation || !authenticated) return;
    if (response.status === 401) {
      authenticated = false; pairing.hidden = true; login.hidden = false; logout.hidden = true;
      devices.replaceChildren(); setStatus('登录已过期，请重新登录。', 'alert'); return;
    }
    if (response.status !== 202) {
      pairingStatus.textContent = response.status === 429 ? '尝试过于频繁，请稍后重试。' : '配对未确认：Key 可能无效、已使用或已过期。'; return;
    }
    pairingStatus.textContent = '认领已提交，等待本机保存并确认绑定；不代表设备已经在线。';
    await load();
  } catch {
    if (current === generation && authenticated) pairingStatus.textContent = '结果暂时不明确，请刷新设备列表核对，不要重新生成配对请求。';
  } finally { claim.disabled = false; }
});
refresh.addEventListener('click', load);

/** Workspaces come from the device's own delegation projection, so the page can
 * only offer ones the machine actually allows. */
function toOptions(entries) {
  return entries.map(entry => {
    const option = document.createElement('option');
    option.value = entry.value; option.textContent = entry.label;
    return option;
  });
}
async function loadDelegations() {
  try {
    const response = await fetch('/api/delegations', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload && payload.delegations) ? payload.delegations : [];
  } catch { return []; }
}
async function refreshTaskTargets() {
  // Same generation guard the rest of the page uses: a delegation reply that
  // lands after logout must not put the signed-in panels back on screen.
  const current = generation;
  const entries = await loadDelegations();
  if (current !== generation || !authenticated) return;
  taskDevice.replaceChildren(...toOptions(entries.map(entry => ({ value: entry.deviceId, label: entry.name || entry.deviceId }))));
  const first = entries[0];
  const workspaces = first && first.delegation && Array.isArray(first.delegation.workspaceIds) ? first.delegation.workspaceIds : [];
  taskWorkspace.replaceChildren(...toOptions(workspaces.map(value => ({ value, label: value }))));
  taskForm.hidden = entries.length === 0;
}
const TASK_ERROR_TEXT = {
  DEVICE_OFFLINE: '设备当前不在线。', DEVICE_UNAVAILABLE: '设备连接不可用。',
  DELEGATION_UNAVAILABLE: '本机尚未开放远程读取。', DELEGATION_EXPIRED: '本机委派已过期。',
  CAPABILITY_DENIED: '本机未开放读取能力。', TASK_DENIED: '本机拒绝了这次读取。',
  WORKSPACE_DENIED: '该任务不在允许的工作区内。', RATE_LIMITED: '请求过于频繁，请稍后重试。',
  OUTCOME_UNKNOWN: '已发出但未收到答复，结果未知：不要当作已完成，也不要当作已失败。',
};
taskForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!authenticated || taskSubmit.disabled) return;
  const current = generation;
  const body = JSON.stringify({ deviceId: taskDevice.value, workspaceId: taskWorkspace.value, taskId: taskId.value.trim() });
  taskSubmit.disabled = true;
  taskResult.className = 'task-result';
  taskResult.textContent = '正在读取…';
  try {
    const response = await fetch('/api/tasks/read', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body });
    if (current !== generation || !authenticated) return;
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      authenticated = false; taskForm.hidden = true; pairing.hidden = true;
      login.hidden = false; logout.hidden = true; devices.replaceChildren();
      setStatus('登录已过期，请重新登录。', 'alert'); return;
    }
    if (response.status !== 200) {
      const code = payload && payload.code;
      taskResult.textContent = '读取未完成：' + (TASK_ERROR_TEXT[code] || ('请稍后重试（' + (code || '未知错误') + '）。'));
      taskResult.className = 'task-result task-result-alert'; return;
    }
    taskResult.textContent = '任务状态：' + JSON.stringify(payload.result === undefined ? payload.status : payload.result);
    taskResult.className = 'task-result task-result-ok';
  } catch {
    if (current === generation && authenticated) {
      taskResult.textContent = '结果暂时不明确，请重试；重试会产生一次新的读取请求。';
      taskResult.className = 'task-result task-result-alert';
    }
  } finally { taskSubmit.disabled = false; }
});
load();`;

/** Static same-origin surface; no embedded identity, secrets or task data. */
export function remoteWebResponse(path, { formActionOrigins = [] } = {}) {
  const content = path === '/' || path === '/devices' ? page
    : path === '/assets/remote.js' ? script
    : path === '/assets/remote.css' ? styles
    : null;
  if (content === null) return null;
  // `form-action` is re-checked on every redirect hop of a form submission, not
  // only on the initial POST target. The login form 303s to the identity provider,
  // which may live on another origin — a different port of the same host is a
  // different origin — so `'self'` alone silently cancels that hop and the page
  // stays on the login form. Callers pass the issuer origin (login.issuer).
  const formAction = ["'self'", ...formActionOrigins.filter((value) => typeof value === 'string' && value !== '')].join(' ');
  const type = path === '/assets/remote.js' ? 'text/javascript; charset=utf-8'
    : path === '/assets/remote.css' ? 'text/css; charset=utf-8'
    : 'text/html; charset=utf-8';
  return new Response(content, { headers: {
    'content-type': type,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    // Must stay `same-origin`, NOT `no-referrer`. With no-referrer the browser
    // serializes this page as an opaque origin, so the login form POST arrives
    // with `Origin: null` and the Origin check in account-http.mjs rejects it
    // with 403 ORIGIN_DENIED. `same-origin` still keeps the referrer from
    // leaking to other origins while preserving the real Origin on same-origin
    // submissions. Regression test: web-surface.test.mjs.
    'referrer-policy': 'same-origin',
    // `style-src 'self'` is required because `default-src 'none'` would block
    // /assets/remote.css outright. No 'unsafe-inline' is granted: the page
    // carries no inline style, so a stylesheet is the only style source.
    'content-security-policy': `default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  } });
}
