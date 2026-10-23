/** Runs in the same-origin browser asset, with the existing read/input HTTP boundary. */
export function projectWebClient(createRemoteHistory) {
  const byId = id => document.getElementById(id);
  const shell = document.querySelector('.project-shell'), list = byId('project-list'), chat = byId('project-chat');
  const messages = byId('project-messages'), tasks = byId('project-tasks'), detail = byId('project-task-detail');
  const status = byId('project-status'), login = byId('project-login'), logout = byId('project-logout');
  const text = byId('project-text'), send = byId('project-send'), inputStatus = byId('input-status');
  const key = bot => JSON.stringify([bot.deviceId, bot.workspaceId]);
  const pending = new Map(), drafts = new Map(), sending = new Set(), histories = new Map(), reading = new Map();
  let authenticated = false, authGeneration = 0, listGeneration = 0, chatGeneration = 0, taskGeneration = 0;
  let selected = null, rows = [], composing = false, loadingChat = false, taskTarget = null;
  let following = true, userScrollUntil = 0, taskOpener = null;
  const errorText = { DEVICE_OFFLINE: '电脑离线，上次内容可继续阅读。连接恢复后重试。', DEVICE_UNAVAILABLE: '电脑连接暂不可用，上次内容仍保留。', PROJECT_DENIED: '电脑未授权查看这个机器人。', MESSAGE_DENIED: '电脑未授权发消息。原消息仍保留，请回电脑检查。', DELEGATION_EXPIRED: '授权已更新或过期，请刷新并在电脑检查。', STALE_CONNECTION: '连接已更新，请刷新。', REQUEST_CONFLICT: '此消息 ID 已对应另一条消息，请在电脑核对。', INPUT_TOO_LONG: '消息超过 4000 字。', RATE_LIMITED: '请求过于频繁，请稍后重试。', CURSOR_STALLED: '更早消息的读取位置未推进，内容已保留，请刷新后重试。', HISTORY_GAP_UNRESOLVED: '新旧记录暂未接上，原内容已保留。可重试或回电脑核对历史。', OUTCOME_UNKNOWN: '可能已送达，未收到确认。重试会使用同一消息 ID。' };
  const labels = { queued: '排队中', running: '进行中', verifying: '核验中', waiting_approval: '请回电脑批准', awaiting_approval: '请回电脑批准', waiting_user: '等你答复', result_ready: '结果待确认', completed: '执行已结束', accepted: '已签收', failed: '失败', cancelled: '已取消', paused: '已暂停', superseded: '已取代', idle: '等待中' };
  const node = (tag, content, cls) => { const el = document.createElement(tag); if (content !== undefined) el.textContent = String(content); if (cls) el.className = cls; return el; };
  const current = (bot, auth) => auth === authGeneration && selected && key(selected) === key(bot);
  const history = bot => { const id = key(bot); if (!histories.has(id)) histories.set(id, createRemoteHistory()); return histories.get(id); };
  function clearPrivate(message) {
    authenticated = false; authGeneration++; listGeneration++; chatGeneration++; taskGeneration++;
    selected = null; taskTarget = null; rows = []; loadingChat = false; composing = false;
    pending.clear(); drafts.clear(); sending.clear(); histories.clear(); reading.clear();
    for (const container of [list, messages, tasks, byId('project-devices')]) container.replaceChildren();
    detail.hidden = true; chat.hidden = true; text.value = ''; shell.dataset.chat = 'false';
    for (const id of ['detail-title', 'detail-status', 'detail-summary']) byId(id).textContent = '';
    taskOpener = null; text.readOnly = false;
    login.hidden = false; logout.hidden = true; status.textContent = message;
    byId('project-refresh').disabled = false; byId('chat-refresh').disabled = false; byId('chat-older').disabled = false; send.disabled = true;
  }
  async function api(url, options = {}) {
    const auth = authGeneration;
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (auth !== authGeneration) throw Error('STALE_RESPONSE');
    if (response.status === 401) { clearPrivate('登录已过期，请重新登录。'); throw Error('AUTH_REQUIRED'); }
    const body = await response.json();
    if (auth !== authGeneration) throw Error('STALE_RESPONSE');
    if (!response.ok) throw Error(body.code || body.error || 'UNAVAILABLE');
    return body;
  }
  function retainFocus(container, mutate) {
    const active = document.activeElement;
    const id = container.contains(active) ? active?.dataset?.navKey : null;
    mutate();
    if (id && document.activeElement !== active) [...container.querySelectorAll('[data-nav-key]')].find(el => el.dataset.navKey === id)?.focus({ preventScroll: true });
  }
function avatar(value){const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 48 48');svg.setAttribute('class','project-avatar');svg.setAttribute('aria-hidden','true');
  const bodies={circle:'M24 6C34 5 42 12 42 23c0 12-8 19-19 19C13 42 6 35 6 25 6 15 13 7 24 6Z',square:'M13 7c7-3 16-2 23 1 5 2 7 8 7 16 0 10-3 16-10 19-7 3-17 2-23-2C6 38 5 32 5 23 5 15 7 10 13 7Z',triangle:'M23 5c5 1 7 7 10 12 4 6 10 12 9 18-1 7-9 10-18 10-11 0-18-3-19-10-1-6 5-13 9-19 3-5 5-10 9-11Z',diamond:'M23 4c5-1 9 5 12 10 4 5 9 8 9 13 0 5-5 9-10 12-5 4-9 7-14 5-5-1-7-6-11-11-4-4-6-8-4-13 2-5 7-7 10-10 3-3 5-5 8-6Z',pill:'M18 5c8-2 17 0 21 7 4 6 3 15 0 22-3 7-8 11-16 11-8 0-15-4-17-11-2-6-1-16 2-22 2-4 5-6 10-7Z'};
  const part=(tag,attrs)=>{const el=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);svg.append(el);return el;};
  part('path',{d:bodies[value?.shape]||bodies.circle,fill:/^#[a-fA-F0-9]{6}$/.test(value?.color)?value.color:'#a884e5'});for(const cx of [18,30])part('ellipse',{cx,cy:24,rx:2,ry:3,fill:'#1a1d21'});part('path',{d:'M21 32q3 3 6 0',fill:'none',stroke:'#1a1d21','stroke-width':2,'stroke-linecap':'round'});return svg;}
  function renderList() {
    retainFocus(list, () => {
      const existing = new Map([...list.children].map(el => [el.dataset.navKey, el]));
      const nodes = rows.map(bot => {
        const id = key(bot), button = existing.get(id) ?? node('button');
        button.type = 'button'; button.className = 'project-row'; button.dataset.navKey = id;
        button.setAttribute('aria-pressed', String(Boolean(selected && key(selected) === id)));
        const copy = node('span', undefined, 'project-row-copy'); copy.append(node('strong', bot.name), node('span', bot.preview || '还没有消息'));
        const counts = [];
        if (bot.state?.needsYou) counts.push('需要你 ' + bot.state.needsYou);
        if (bot.state?.running) counts.push('进行中 ' + bot.state.running);
        if (pending.has(id)) counts.push('消息待确认');
        button.replaceChildren(avatar(bot.avatar), copy, node('span', counts.join(' · '), 'project-row-count'));
        button.onclick = () => openBot(bot); return button;
      });
      list.replaceChildren(...nodes);
      if (!rows.length) list.append(node('p', '尚无可用的获授权机器人。请检查电脑连接与远程授权。', 'panel-note'));
    });
  }
  function saveDraft() { if (selected && !pending.has(key(selected))) drafts.set(key(selected), text.value); }
  function renderComposer(restore = false) {
    if (!selected) return;
    const id = key(selected), entry = pending.get(id);
    if (restore || entry) text.value = entry?.text ?? drafts.get(id) ?? '';
    text.readOnly = Boolean(entry);
    send.disabled = !selected.canMessage || selected.offline || selected.denied || sending.has(id);
    send.textContent = entry ? '重试同一消息' : '发送';
    inputStatus.textContent = sending.has(id) ? '正在发送…' : entry ? errorText.OUTCOME_UNKNOWN
      : selected.offline ? errorText.DEVICE_OFFLINE : selected.denied ? errorText.PROJECT_DENIED
        : selected.canMessage ? '最多 4000 字，无附件；Enter 换行，Ctrl/⌘+Enter 发送。草稿仅在此页面保留。'
          : '仅可查看。请在电脑上开放发消息权限。';
  }
  function rememberReading() {
    if (!selected) return;
    const anchor = [...messages.children].find(el => el.dataset.messageId && el.getBoundingClientRect().bottom > messages.getBoundingClientRect().top);
    reading.set(key(selected), { following, id: anchor?.dataset.messageId,
      delta: anchor ? anchor.getBoundingClientRect().top - messages.getBoundingClientRect().top : 0, top: messages.scrollTop });
  }
  function leaveChat() {
    saveDraft(); rememberReading(); const id = selected && key(selected);
    chatGeneration++; taskGeneration++; selected = null; taskTarget = null; loadingChat = false;
    chat.hidden = true; detail.hidden = true; shell.dataset.chat = 'false'; renderList();
    [...list.children].find(el => el.dataset.navKey === id)?.focus({ preventScroll: true });
  }
  async function load() {
    if (logout.disabled) return;
    const generation = ++listGeneration, auth = authGeneration;
    byId('project-refresh').disabled = true; status.textContent = '正在刷新…';
    try {
      const payload = await api('/api/projects');
      if (generation !== listGeneration || auth !== authGeneration) return;
      if (!Array.isArray(payload.projects) || !Array.isArray(payload.devices)) throw Error('UNAVAILABLE');
      authenticated = true; login.hidden = true; logout.hidden = false; rows = payload.projects;
      if (selected) {
        saveDraft();
        const updated = rows.find(row => key(row) === key(selected));
        const device = payload.devices.find(device => device.deviceId === selected.deviceId);
        if (updated) { selected = updated; renderComposer(); }
        else if (device && device.status !== 'online') { selected = { ...selected, offline: true }; renderComposer(); }
        else {
          const id = key(selected); leaveChat(); histories.delete(id); reading.delete(id);
          messages.replaceChildren(); tasks.replaceChildren(); byId('detail-summary').textContent = ''; text.value = '';
        }
      }
      renderList();
      byId('project-devices').replaceChildren(...payload.devices.map(d => node('p', (d.name || '电脑') + ' · ' + (d.status === 'online' ? '在线' : errorText[d.status] || '尚未开放项目访问'))));
      status.textContent = '已更新 ' + rows.length + ' 个机器人';
    } catch (error) { if (generation === listGeneration && auth === authGeneration) status.textContent = errorText[error.message] || '暂时无法连接，原内容已保留，请重试。'; }
    finally { if (generation === listGeneration && auth === authGeneration) byId('project-refresh').disabled = false; }
  }
  function taskButton(bot, session) {
    const button = node('button', (session.title || '任务') + (session.status ? ' · ' + (labels[session.status] || session.status) : ''));
    button.type = 'button'; button.dataset.navKey = 'task:' + session.sessionId;
    button.addEventListener('click', () => { taskOpener = button; void readTask(bot, session.sessionId); }); return button;
  }
  function renderMessages(bot, snapshot, older = false) {
    const anchor = [...messages.children].find(el => el.dataset.messageId && el.getBoundingClientRect().bottom > messages.getBoundingClientRect().top);
    const saved = { id: anchor?.dataset.messageId, delta: anchor ? anchor.getBoundingClientRect().top - messages.getBoundingClientRect().top : 0, top: messages.scrollTop };
    const existing = new Map([...messages.children].map(el => [el.dataset.messageId, el]));
    retainFocus(messages, () => {
      const nodes = snapshot.messages.flatMap(message => {
        const el = existing.get(message.id) ?? node('article');
        const value = JSON.stringify(message);
        if (el.dataset.revision !== value) {
          el.className = 'project-message ' + message.kind; el.dataset.messageId = message.id; el.dataset.revision = value;
          el.replaceChildren(node('div', (message.kind === 'user_input' ? '你' : message.kind === 'agent_reply' ? bot.name : '事项') + ' · ' + (message.createdAt ? new Date(message.createdAt).toLocaleString() : ''), 'message-meta'), node('p', message.content));
          if (message.replyTo?.length) el.append(node('p', '回复 ' + message.replyTo.length + ' 条消息', 'message-meta'));
          if (message.needsDesktopApproval) el.append(node('p', '需要在电脑上批准', 'approval-note'));
          for (const source of message.sourceSessionIds ?? []) { const button = taskButton(bot, { sessionId: source, title: '查看任务' }); button.className = 'message-task'; el.append(button); }
        }
        return message.id === snapshot.gapBefore ? [node('p', '新旧记录尚未接上，请继续读取更早消息。', 'panel-note'), el] : [el];
      });
      messages.replaceChildren(...nodes);
    });
    userScrollUntil = 0;
    if (following && !older) messages.scrollTop = messages.scrollHeight;
    else {
      const same = [...messages.children].find(el => el.dataset.messageId === saved.id);
      messages.scrollTop = same ? messages.scrollTop + same.getBoundingClientRect().top - messages.getBoundingClientRect().top - saved.delta : saved.top;
    }
    byId('chat-older').hidden = !snapshot.nextCursor;
    byId('chat-refresh').textContent = snapshot.gapBefore ? '继续衔接历史' : '更新对话';
  }
  function openBot(bot) {
    saveDraft(); rememberReading(); selected = bot; chatGeneration++; taskGeneration++; taskTarget = null; composing = false; loadingChat = false;
    detail.hidden = true; chat.hidden = false; shell.dataset.chat = 'true'; following = true;
    messages.replaceChildren(); tasks.replaceChildren(); byId('chat-title').textContent = bot.name;
    const checkpoint = reading.get(key(bot)); following = checkpoint?.following ?? true;
    renderList(); renderComposer(true); renderMessages(bot, history(bot).snapshot());
    if (checkpoint && !checkpoint.following) {
      const anchor = [...messages.children].find(el => el.dataset.messageId === checkpoint.id);
      messages.scrollTop = anchor ? messages.scrollTop + anchor.getBoundingClientRect().top - messages.getBoundingClientRect().top - checkpoint.delta : checkpoint.top;
    }
    byId('chat-title').focus({ preventScroll: true }); void readConversation(false);
  }
  async function readConversation(older) {
    if (!selected || loadingChat || older && !history(selected).snapshot().nextCursor) return;
    if (history(selected).snapshot().gapBefore) older = true;
    saveDraft(); loadingChat = true;
    const bot = selected, generation = ++chatGeneration, auth = authGeneration;
    const cursor = older ? history(bot).snapshot().nextCursor : null;
    byId('chat-refresh').disabled = true; byId('chat-older').disabled = true;
    byId('chat-status').textContent = '正在读取…';
    try {
      const payload = await api('/api/projects/' + encodeURIComponent(bot.workspaceId) + '/conversation?deviceId=' + encodeURIComponent(bot.deviceId) + (cursor ? '&before=' + encodeURIComponent(cursor) : ''));
      if (generation !== chatGeneration || !current(bot, auth)) return;
      const snapshot = history(bot).accept(payload.result, older);
      renderMessages(bot, snapshot, older);
      retainFocus(tasks, () => {
        tasks.replaceChildren(...(payload.result.sessions ?? []).map(session => taskButton(bot, session)));
        for (const approval of payload.result.pendingApprovals ?? []) tasks.append(node('p', '需要在电脑上批准 · ' + approval.summary, 'approval-note'));
      });
      selected = { ...selected, canMessage: payload.result.canMessage, offline: false, denied: false };
      renderComposer(); byId('chat-status').textContent = snapshot.gapBefore ? '新记录尚未接上历史，可继续读取更早消息。' : snapshot.messages.length ? '对话已更新；预览不替代电脑上的核验与签收。' : '还没有对话，给机器人交代一件事吧。';
    } catch (error) {
      if (generation !== chatGeneration || !current(bot, auth)) return;
      if (['PROJECT_DENIED', 'DELEGATION_EXPIRED'].includes(error.message)) {
        histories.delete(key(bot)); reading.delete(key(bot)); messages.replaceChildren(); tasks.replaceChildren(); taskGeneration++; taskTarget = null; detail.hidden = true; byId('detail-summary').textContent = ''; selected = { ...selected, denied: true }; renderComposer();
      }
      byId('chat-status').textContent = errorText[error.message] || '读取未完成，保留上次内容，请重试。';
    } finally {
      if (generation === chatGeneration && current(bot, auth)) { loadingChat = false; byId('chat-refresh').disabled = false; byId('chat-older').disabled = false; }
    }
  }
  async function readTask(bot, sessionId) {
    const ticket = ++taskGeneration, auth = authGeneration;
    taskTarget = { bot, sessionId }; detail.hidden = false;
    byId('detail-title').textContent = '任务'; byId('detail-status').textContent = '正在读取…'; byId('detail-summary').textContent = '';
    byId('task-retry').hidden = true; byId('task-close').focus({ preventScroll: true });
    try {
      const payload = await api('/api/projects/' + encodeURIComponent(bot.workspaceId) + '/sessions/' + encodeURIComponent(sessionId) + '?deviceId=' + encodeURIComponent(bot.deviceId));
      if (ticket !== taskGeneration || !current(bot, auth)) return;
      if (!payload.result) throw Error('UNAVAILABLE');
      byId('detail-title').textContent = payload.result.title || '任务';
      byId('detail-status').textContent = labels[payload.result.status] || payload.result.status;
      byId('detail-summary').textContent = payload.result.summary || '暂无报告摘要';
    } catch (error) {
      if (ticket !== taskGeneration || !current(bot, auth)) return;
      byId('detail-status').textContent = errorText[error.message] || '任务读取未完成。'; byId('task-retry').hidden = false;
    }
  }
  byId('project-input').addEventListener('submit', async event => {
    event.preventDefault();
    if (composing || !authenticated || !selected || !selected.canMessage || selected.offline || selected.denied) return;
    const bot = selected, id = key(bot), auth = authGeneration;
    if (sending.has(id)) return;
    const body = pending.get(id) ?? { deviceId: bot.deviceId, inputId: crypto.randomUUID(), text: text.value.trim() };
    if (!body.text || Array.from(body.text).length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) { inputStatus.textContent = '请输入 1–4000 字的消息。'; return; }
    pending.set(id, body); sending.add(id); renderComposer();
    try {
      const answer = await api('/api/projects/' + encodeURIComponent(bot.workspaceId) + '/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (auth !== authGeneration) return;
      if (answer.requestId !== body.inputId || answer.status !== 'ok' || answer.result?.status !== 'received') throw Error('OUTCOME_UNKNOWN');
      pending.delete(id); drafts.delete(id);
      if (current(bot, auth)) { text.value = ''; inputStatus.textContent = '电脑已收到，正在等待机器人处理。'; void readConversation(false); }
    } catch (error) {
      if (current(bot, auth)) { renderComposer(); inputStatus.textContent = errorText[error.message] || errorText.OUTCOME_UNKNOWN; }
    } finally {
      if (auth === authGeneration) { sending.delete(id); if (current(bot, auth)) { send.disabled = !selected.canMessage || selected.offline || selected.denied; send.textContent = pending.has(id) ? '重试同一消息' : '发送'; } renderList(); }
    }
  });
  text.addEventListener('input', saveDraft);
  text.addEventListener('compositionstart', () => { composing = true; });
  text.addEventListener('compositionend', () => { composing = false; saveDraft(); });
  text.addEventListener('keydown', event => { if (event.isComposing || composing || event.keyCode === 229) return; if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); byId('project-input').requestSubmit(); } });
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) messages.addEventListener(type, event => {
    if (type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    following = false; userScrollUntil = Date.now() + 200;
  }, { passive: true });
  messages.addEventListener('scroll', () => { if (Date.now() <= userScrollUntil) following = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 24; });
  messages.addEventListener('load', () => { if (following) messages.scrollTop = messages.scrollHeight; }, true);
  byId('chat-latest').addEventListener('click', () => { following = true; userScrollUntil = 0; messages.scrollTop = messages.scrollHeight; });
  byId('project-refresh').addEventListener('click', load);
  byId('chat-refresh').addEventListener('click', () => void readConversation(false));
  byId('chat-older').addEventListener('click', () => void readConversation(true));
  byId('project-back').addEventListener('click', leaveChat);
  byId('task-close').addEventListener('click', () => { taskGeneration++; taskTarget = null; detail.hidden = true; (taskOpener?.isConnected ? taskOpener : byId('chat-refresh')).focus({ preventScroll: true }); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !composing && !detail.hidden) { event.preventDefault(); byId('task-close').click(); }
  });
  byId('task-retry').addEventListener('click', () => { if (taskTarget) void readTask(taskTarget.bot, taskTarget.sessionId); });
  logout.addEventListener('click', async () => {
    clearPrivate('正在退出…'); logout.disabled = true;
    try { const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); if (!response.ok) throw Error('logout'); status.textContent = '已退出。电脑上的机器人继续运行。'; }
    catch { logout.hidden = false; status.textContent = '退出未确认，请重试。'; }
    finally { logout.disabled = false; }
  });
  window.addEventListener('pagehide', () => { saveDraft(); rememberReading(); authGeneration++; chatGeneration++; taskGeneration++; sending.clear(); loadingChat = false; });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    byId('chat-refresh').disabled = false; byId('chat-older').disabled = false;
    if (taskTarget && !detail.hidden) { byId('detail-status').textContent = '页面已恢复，请重新读取任务状态。'; byId('task-retry').hidden = false; }
    renderComposer(); void load();
  });
  void load();
}
