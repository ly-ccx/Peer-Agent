// Chromium geometry regression: isolates the production CSS and composer DOM layout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const css = [
  'styles/tokens.css',
  'chat/styles/chat-surface.css',
  'chat/styles/goal-panel.css',
  'chat/styles/goal-investigation.css',
  'project-agent/styles/bot-conversation.css',
  'project-agent/styles/bot-touchbar.css',
  'chat/components/input-prediction.css',
].map(file => readFileSync(new URL(`../renderer/src/${file}`, import.meta.url), 'utf8')).join('\n');

const hint = `<div class="input-prediction-mirror" aria-hidden="true"></div>
  <button type="button" class="input-prediction-accept"><kbd>Tab</kbd><span>采纳建议</span></button>
  <span class="input-prediction-status" role="status">建议可用</span>`;

function render({ surface, toolbar, width, scale }) {
  const bot = surface === 'bot';
  const expanded = toolbar === 'expanded';
  const form = `<form class="${bot ? 'bot-composer' : `chat-composer chat-composer--${surface}`}">
    <div class="composer-input-field"><textarea rows="1">请检查一下过渡</textarea></div>
    ${bot ? `<div class="bot-composer-bar">
      <div class="bot-composer-leading"><button type="button">+</button></div>
      <div class="bot-composer-actions"><button type="button">模型</button><button type="submit">↑</button></div>
    </div>` : `<div class="composer-home-action-row">
      <div class="composer-home-action-left"><button type="button" class="composer-attach-btn">+</button></div>
      <button type="submit">↑</button>
    </div>`}
  </form>`;
  const botToolbar = `<div class="bot-touchbar-strip bot-touchbar-summary" role="toolbar">
    <div class="bot-tb-left"><button class="bot-tb-status" type="button"><span class="bot-tb-status-text">2 个任务 · 1 个运行中</span></button></div>
    <div class="bot-tb-right"><button class="bot-tb-chip${expanded ? ' is-open' : ''}" aria-expanded="${expanded}" type="button">
      <svg width="13" height="13" aria-hidden="true"><circle cx="6" cy="6" r="5"/></svg><span>历史任务</span><span class="bot-tb-count">2</span>
    </button></div>
  </div>`;
  const botTray = `<section class="bot-touchbar-tray" aria-label="历史任务"><header class="bot-tray-head">
    <span class="bot-tray-title">Bot · 历史任务</span><button type="button" class="bot-tray-close">×</button>
  </header><div class="bot-tray-list"><div class="bot-tray-empty">共 2 条已收口记录</div></div></section>`;
  const chatToolbar = `<div class="composer-chrome-row"><div class="composer-chrome-left">
    ${toolbar === 'absent' ? '' : `<div class="goal-investigation-anchor"><div class="goal-panel goal-panel--docked${expanded ? ' goal-panel--expanded' : ''}">
      <button type="button" class="goal-panel-toggle" aria-expanded="${expanded}"><span class="goal-panel-toggle-active">
        <span class="goal-panel-toggle-summary"><span class="goal-panel-toggle-active-title">检查桌面布局</span></span>
        <span class="goal-panel-toggle-active-progress">1/4</span>
      </span><span class="goal-panel-toggle-caret">⌄</span></button>
      ${expanded ? '<div class="goal-panel-body"><div class="goal-plan-history-title">历史计划 2</div></div>' : ''}
    </div></div>`}
  </div></div>`;
  return `<style>${css}
    :root { font-size: ${16 * scale}px; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; }
  </style>
  <main style="width:${width + (bot ? 56 + (toolbar === 'absent' ? 0 : 2) : surface === 'home' ? 144 : 48)}px; margin: 240px auto 0">
    ${bot ? `<div class="bot-convo">${toolbar === 'absent' ? form : `<div class="bot-composer-shell"><div class="bot-composer-unit${expanded ? ' is-tray-open' : ''}">
      ${expanded ? botTray : ''}${botToolbar}${form}</div></div>`}</div>` : `<div class="chat-composer-wrap${surface === 'home' ? ' chat-composer-wrap--empty-home' : ''}">${chatToolbar}${form}</div>`}
  </main>`;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
  const cases = [];
  for (const surface of ['bot', 'compact', 'home']) {
    for (const toolbar of ['absent', 'collapsed', 'expanded']) {
      for (const width of [280, 360, 760]) {
        for (const scale of [1, 1.5]) cases.push({ surface, toolbar, width, scale });
      }
    }
  }
  for (const scenario of cases) {
    const { surface, toolbar, width, scale } = scenario;
    const name = `${surface}/${toolbar}/${width}px/${scale}x`;
    await page.setContent(render(scenario));
    const result = await page.evaluate(markup => {
      const field = document.querySelector('.composer-input-field');
      const textarea = field.querySelector('textarea');
      const rect = node => node.getBoundingClientRect().toJSON();
      const textLayout = () => {
        const { x, y, width, height } = rect(textarea);
        const { fontSize, lineHeight, padding, overflowWrap } = getComputedStyle(textarea);
        return { x, y, width, height, fontSize, lineHeight, padding, overflowWrap, scrollHeight: textarea.scrollHeight };
      };
      const before = textLayout();
      field.insertAdjacentHTML('beforeend', markup);
      const button = field.querySelector('.input-prediction-accept');
      const buttonBox = rect(button);
      const actionRow = document.querySelector('.bot-composer-bar, .composer-home-action-row');
      const topPanels = [...document.querySelectorAll('.bot-touchbar-tray, .bot-touchbar-strip, .composer-chrome-row')]
        .filter(node => node.getClientRects().length).map(rect);
      return { before, after: textLayout(), form: rect(field.closest('form')), field: rect(field),
        textarea: rect(textarea), button: buttonBox, actions: rect(actionRow), topPanels,
        mirrorAnchored: field.querySelector('.input-prediction-mirror').offsetParent === field,
        clickable: button.contains(document.elementFromPoint(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)),
      };
    }, hint);
    const { before, after, form, field, textarea, button, actions, topPanels } = result;
    assert.equal(form.width, width, `${name}: fixture must exercise the requested composer width`);
    const panelCount = toolbar === 'absent' ? 0 : surface === 'bot' && toolbar === 'expanded' ? 2 : 1;
    assert.equal(topPanels.length, panelCount, `${name}: expected toolbar/tray state`);
    for (const panel of topPanels) {
      assert.ok(panel.height > 0 && panel.bottom <= button.top, `${name}: suggestion overlaps toolbar/tray`);
    }
    assert.ok(button.height > 0 && button.width > 0 && button.left >= field.left && button.right <= field.right,
      `${name}: suggestion must fit within field width`);
    assert.ok(textarea.bottom <= button.top, `${name}: suggestion overlaps textarea`);
    assert.ok(button.bottom <= actions.top, `${name}: suggestion overlaps action row`);
    assert.ok(result.mirrorAnchored, `${name}: ghost text must use the input field as its containing block`);
    assert.ok(result.clickable, `${name}: suggestion must be clickable`);
    assert.deepEqual(after, before, `${name}: showing a suggestion changes textarea geometry or text layout`);
  }
  console.log(`PASS input prediction layout: ${cases.length} cases (3 surfaces × 3 toolbar states × 3 widths × 2 font scales)`);
} finally {
  await browser.close();
}
