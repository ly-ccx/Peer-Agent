const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Peer · 远程设备</title></head>
<body><main><h1>远程设备</h1><p>登录后查看你绑定的电脑。本地使用 Peer 无需登录。</p>
<p id="status" role="status">正在检查登录状态…</p>
<form id="login" action="/auth/login" method="post" hidden><button type="submit">登录 Peer</button></form>
<section id="devices" aria-label="设备列表"></section>
<form id="pairing" hidden><h2>添加设备</h2><p>从本机 Peer 取得配对信息。当前开发版本需要挑战 ID 和一次性 Key，请勿转发。</p>
<label for="challenge">挑战 ID</label><input id="challenge" required maxlength="128" autocomplete="off">
<label for="pairing-key">一次性 Key</label><input id="pairing-key" type="password" required maxlength="256" autocomplete="off">
<button id="claim" type="submit">绑定设备</button><p id="pairing-status" role="status"></p></form>
<button id="refresh" type="button">刷新设备</button> <button id="logout" type="button" hidden>退出当前登录</button>
<p>在线仅代表连接可用。当前版本尚未开放远程任务操作。</p>
</main><script src="/assets/remote.js" defer></script></body></html>`;

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
let authenticated = false;
let generation = 0;
async function load() {
  if (logout.disabled) return;
  const current = ++generation;
  devices.replaceChildren();
  status.textContent = '正在刷新…';
  try {
    const response = await fetch('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
    if (current !== generation) return;
    if (response.status === 401) {
      authenticated = false; pairing.hidden = true; pairingKey.value = '';
      login.hidden = false; logout.hidden = true;
      status.textContent = '请登录后查看设备。登录过期不会解除设备绑定。'; return;
    }
    if (!response.ok) throw new Error('unavailable');
    const payload = await response.json();
    if (current !== generation) return;
    if (!Array.isArray(payload.devices)) throw new Error('invalid');
    authenticated = true; pairing.hidden = false;
    login.hidden = true; logout.hidden = false;
    status.textContent = payload.devices.length ? '设备状态已更新' : '尚未绑定电脑。请在目标电脑发起配对。';
    for (const device of payload.devices) {
      const card = document.createElement('article');
      const title = document.createElement('h2'); title.textContent = String(device.name ?? '未命名设备');
      const state = document.createElement('p');
      state.textContent = device.revoked ? '已撤销绑定' : device.online === true ? '在线 · 执行权限尚未接入' : '离线或连接状态未确认';
      card.append(title, state); devices.append(card);
    }
  } catch {
    if (current === generation) status.textContent = '暂时无法获取设备状态，请重试。';
  }
}
logout.addEventListener('click', async () => {
  if (logout.disabled) return;
  ++generation; authenticated = false; pairing.hidden = true; pairingKey.value = '';
  challenge.value = ''; pairingStatus.textContent = '';
  devices.replaceChildren(); logout.disabled = true; refresh.disabled = true;
  try {
    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error('logout failed');
    login.hidden = false; logout.hidden = true;
    status.textContent = '已退出当前登录。设备绑定与本机服务不受影响。';
  } catch { status.textContent = '退出未确认，请重试。'; }
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
      devices.replaceChildren(); status.textContent = '登录已过期，请重新登录。'; return;
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
load();`;

/** Static same-origin surface; no embedded identity, secrets or task data. */
export function remoteWebResponse(path) {
  const content = path === '/' || path === '/devices' ? page : path === '/assets/remote.js' ? script : null;
  if (content === null) return null;
  return new Response(content, { headers: {
    'content-type': path === '/assets/remote.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}
