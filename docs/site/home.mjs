import { desktopScenarios, stories, t } from './copy.mjs';
import { currentLanguage, onLanguage } from './site.mjs';

let activeStage = 'desktop';
let activeScenario = 'approval';
let activeCapture = 'home';
let selectedStory = 0;

const stageTabs = [...document.querySelectorAll('[data-stage-tab]')];
const stagePanels = [...document.querySelectorAll('[data-stage-panel]')];
const scenarioButtons = [...document.querySelectorAll('[data-scenario]')];
const simBotButtons = [...document.querySelectorAll('[data-sim-bot]')];
const scenarioWrap = document.getElementById('stage-scenarios');
const captureButtons = [...document.querySelectorAll('[data-capture-view]')];

function pick(pair, lang) {
  return pair[lang === 'zh' ? 1 : 0];
}

function renderStage() {
  const lang = currentLanguage();
  stageTabs.forEach(tab => {
    const on = tab.dataset.stageTab === activeStage;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  });
  stagePanels.forEach(panel => {
    panel.hidden = panel.dataset.stagePanel !== activeStage;
  });
  if (scenarioWrap) scenarioWrap.hidden = activeStage !== 'desktop';

  const caption = document.getElementById('stage-caption');
  if (caption) {
    caption.textContent = t(activeStage === 'capture' ? 'stage.caption.capture' : 'stage.caption.interactive', lang);
  }

  renderScenario(lang);
  renderCapture(lang);
}

function renderScenario(lang) {
  const sc = desktopScenarios[activeScenario];
  if (!sc) return;

  scenarioButtons.forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.scenario === activeScenario));
  });
  simBotButtons.forEach(btn => {
    btn.setAttribute('aria-selected', String(btn.dataset.simBot === sc.botId));
  });

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('sim-thread-title', pick(sc.title, lang));
  setText('sim-thread-sub', pick(sc.sub, lang));
  setText('sim-user-msg', pick(sc.user, lang));
  setText('sim-user-receipt', pick(sc.receipt, lang));
  setText('sim-quote-ref', pick(sc.quote, lang));
  setText('sim-reply-body', pick(sc.reply, lang));
  setText('sim-card-title', pick(sc.cardTitle, lang));
  setText('sim-card-tag', pick(sc.cardTag, lang));
  setText('sim-card-cmd', pick(sc.cardCmd, lang));
  setText('sim-composer-text', pick(sc.composer, lang));
  setText('sim-wp-focus-label', pick(sc.wpFocusLabel, lang));
  setText('sim-wp-focus-text', pick(sc.wpFocusText, lang));

  const tagEl = document.getElementById('sim-card-tag');
  if (tagEl) {
    tagEl.className = 'sim-card-tag ' + (sc.cardType === 'verified' ? 'good' : 'warn');
  }

  const actionsEl = document.getElementById('sim-card-actions');
  if (actionsEl) {
    actionsEl.replaceChildren();
    sc.cardActions.forEach((labelPair, index) => {
      const span = document.createElement('span');
      span.className = 'sim-btn-mini' + (index === 0 ? ' primary' : '');
      span.textContent = pick(labelPair, lang);
      actionsEl.appendChild(span);
    });
  }

  const tasksEl = document.getElementById('sim-wp-tasks');
  if (tasksEl) {
    tasksEl.replaceChildren();
    sc.tasks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'sim-task-item';

      const top = document.createElement('div');
      top.className = 'sim-task-top';
      const strong = document.createElement('span');
      strong.textContent = pick(task.name, lang);
      const pct = document.createElement('span');
      pct.className = 'cli-muted';
      pct.textContent = task.pct + '%';
      top.append(strong, pct);

      const sub = document.createElement('div');
      sub.className = 'sim-task-sub';
      sub.textContent = pick(task.meta, lang);

      const bar = document.createElement('div');
      bar.className = 'sim-progress';
      const fill = document.createElement('i');
      fill.style.width = task.pct + '%';
      bar.appendChild(fill);

      item.append(top, sub, bar);
      tasksEl.appendChild(item);
    });
  }

  const agentsEl = document.getElementById('sim-wp-agents');
  if (agentsEl) {
    agentsEl.replaceChildren();
    sc.agents.forEach(agent => {
      const item = document.createElement('div');
      item.className = 'sim-task-item';
      const top = document.createElement('div');
      top.className = 'sim-task-top';
      const name = document.createElement('span');
      name.textContent = pick(agent.name, lang);
      const st = document.createElement('span');
      st.className = 'cli-muted';
      st.textContent = pick(agent.status, lang);
      top.append(name, st);
      item.appendChild(top);
      agentsEl.appendChild(item);
    });
  }

  const matEl = document.getElementById('sim-wp-materials');
  if (matEl) {
    matEl.replaceChildren();
    sc.materials.forEach(file => {
      const row = document.createElement('div');
      row.className = 'sim-material-row';
      const name = document.createElement('span');
      name.textContent = file;
      const hint = document.createElement('span');
      hint.textContent = lang === 'zh' ? '工作区' : '4th pane';
      row.append(name, hint);
      matEl.appendChild(row);
    });
  }
}

function renderCapture(lang) {
  captureButtons.forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.captureView === activeCapture));
  });
  const homeShot = document.getElementById('capture-home');
  const profileShot = document.getElementById('capture-profile');
  if (homeShot) homeShot.hidden = activeCapture !== 'home';
  if (profileShot) profileShot.hidden = activeCapture !== 'profile';
  const note = document.getElementById('capture-note');
  if (note) {
    note.textContent = activeCapture === 'profile'
      ? (lang === 'zh' ? '机器人档案 · 角色路由、执行宿主与策略设置' : 'Bot Profile · model routing, host lease and acceptance policy')
      : (lang === 'zh' ? '机器人列表 · 主对话工作界面（浅色/深色自动随主题切换）' : 'Bot List & main thread (switches automatically with light/dark theme)');
  }
}

stageTabs.forEach((tab, index) => {
  tab.disabled = false;
  tab.addEventListener('click', () => {
    activeStage = tab.dataset.stageTab;
    renderStage();
  });
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % stageTabs.length;
    if (event.key === 'ArrowLeft') next = (index + stageTabs.length - 1) % stageTabs.length;
    if (next !== undefined) {
      event.preventDefault();
      activeStage = stageTabs[next].dataset.stageTab;
      renderStage();
      stageTabs[next].focus();
    }
  });
});

scenarioButtons.forEach(btn => {
  btn.disabled = false;
  btn.addEventListener('click', () => {
    activeScenario = btn.dataset.scenario;
    renderScenario(currentLanguage());
  });
});

simBotButtons.forEach(btn => {
  btn.disabled = false;
  btn.addEventListener('click', () => {
    const map = { 'peer-agent': 'approval', 'docs-site': 'parallel', 'research': 'verified' };
    activeScenario = map[btn.dataset.simBot] || 'approval';
    renderScenario(currentLanguage());
  });
});

captureButtons.forEach(btn => {
  btn.disabled = false;
  btn.addEventListener('click', () => {
    activeCapture = btn.dataset.captureView;
    renderCapture(currentLanguage());
  });
});

/* ─── 5-Step Walkthrough ─── */
const storyButtons = [...document.querySelectorAll('[data-story]')];
const storyFields = { request: 'story-request', bot: 'story-bot', owner: 'story-owner' };

function renderStory() {
  const lang = currentLanguage();
  const row = stories[selectedStory];
  if (!row) return;
  document.getElementById('story-title').textContent = t(row.title, lang);
  document.getElementById('story-panel').setAttribute('aria-labelledby', 'step-' + selectedStory);
  document.getElementById('story-version').textContent = t('story.preview', lang);
  for (const [key, id] of Object.entries(storyFields)) {
    document.getElementById(id).textContent = pick(row[key], lang);
  }
  storyButtons.forEach((button, i) => {
    button.setAttribute('aria-selected', String(i === selectedStory));
    button.tabIndex = i === selectedStory ? 0 : -1;
  });

  const visual = document.getElementById('story-visual');
  if (visual && row.visual) {
    visual.replaceChildren();
    const head = document.createElement('div');
    head.className = 'sv-head';
    const tag = document.createElement('span');
    tag.textContent = pick(row.visual.tag, lang);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = pick(row.visual.badge, lang);
    head.append(tag, badge);
    visual.appendChild(head);

    row.visual.rows.forEach(r => {
      const box = document.createElement('div');
      box.className = 'sv-row' + (r.tone ? ' ' + r.tone : '');
      const strong = document.createElement('strong');
      strong.textContent = pick(r.title, lang);
      const sub = document.createElement('span');
      sub.textContent = pick(r.sub, lang);
      box.append(strong, sub);
      visual.appendChild(box);
    });
  }
}

function selectStory(index, focus = false) {
  selectedStory = index;
  renderStory();
  if (focus) storyButtons[index].focus();
}

storyButtons.forEach((button, index) => {
  button.disabled = false;
  button.addEventListener('click', () => selectStory(index));
  button.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % storyButtons.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + storyButtons.length - 1) % storyButtons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = storyButtons.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectStory(next, true);
    }
  });
});

/* ─── CLI Channel Switcher ─── */
document.querySelectorAll('[data-cli-channel]').forEach(button => {
  button.disabled = false;
  button.addEventListener('click', () => {
    const preview = button.dataset.cliChannel === 'rc';
    document.getElementById('cli-command').textContent = 'npm install -g @peer-agent/cli' + (preview ? '@rc' : '');
    document.querySelectorAll('[data-cli-channel]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    document.getElementById('copy-status').textContent = '';
  });
});

onLanguage(() => {
  renderStage();
  renderStory();
});
