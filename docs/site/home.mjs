import { stories, t } from './copy.mjs';
import { currentLanguage, onLanguage } from './site.mjs';

const buttons = [...document.querySelectorAll('[data-story]')];
let selected = 0;
const fields = { request: 'story-request', bot: 'story-bot', owner: 'story-owner' };
function renderStory() {
  const lang = currentLanguage();
  const row = stories[selected];
  document.getElementById('story-title').textContent = t(row.title, lang);
  document.getElementById('story-panel').setAttribute('aria-labelledby', 'step-' + selected);
  document.getElementById('story-version').textContent = t(row.development ? 'story.development' : 'story.preview', lang);
  for (const [key, id] of Object.entries(fields)) document.getElementById(id).textContent = row[key][lang === 'zh' ? 1 : 0];
  buttons.forEach((button, i) => {
    button.setAttribute('aria-selected', String(i === selected));
    button.tabIndex = i === selected ? 0 : -1;
  });
}
function selectStory(index, focus = false) {
  selected = index;
  renderStory();
  if (focus) buttons[index].focus();
}
buttons.forEach((button, index) => {
  button.disabled = false;
  button.addEventListener('click', () => selectStory(index));
  button.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + buttons.length - 1) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next !== undefined) { event.preventDefault(); selectStory(next, true); }
  });
});
onLanguage(renderStory);

document.querySelectorAll('[data-cli-channel]').forEach(button => {
  button.disabled = false;
  button.addEventListener('click', () => {
    const preview = button.dataset.cliChannel === 'rc';
    document.getElementById('cli-command').textContent = 'npm install -g @peer-agent/cli' + (preview ? '@rc' : '');
    document.querySelectorAll('[data-cli-channel]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    document.getElementById('copy-status').textContent = '';
  });
});
