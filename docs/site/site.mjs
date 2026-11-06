import { copy, t } from './copy.mjs';

const LANG_KEY = 'peer-landing-lang';
const THEME_KEY = 'peer-theme';
const listeners = new Set();
const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Preferences remain usable without storage. */ } };
const requestedLanguage = new URLSearchParams(location.search).get('lang');
let language = ['en', 'zh'].includes(requestedLanguage) ? requestedLanguage : (read(LANG_KEY, 'en') === 'zh' ? 'zh' : 'en');
if (requestedLanguage === 'en' || requestedLanguage === 'zh') write(LANG_KEY, language);
let theme = ['system', 'light', 'dark'].includes(read(THEME_KEY, 'system')) ? read(THEME_KEY, 'system') : 'system';
const dark = matchMedia('(prefers-color-scheme: dark)');

export const currentLanguage = () => language;
export const onLanguage = callback => { listeners.add(callback); callback(language); return () => listeners.delete(callback); };
export function registerCopy(pairs) { Object.assign(copy, pairs); applyLanguage(language); }

function applyTheme() {
  document.documentElement.dataset.theme = theme === 'system' ? (dark.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.themePref = theme;
  document.querySelectorAll('[data-logo-light]').forEach(img => {
    img.src = document.documentElement.dataset.theme === 'dark' ? img.dataset.logoDark : img.dataset.logoLight;
  });
  const button = document.querySelector('[data-theme-toggle]');
  if (button) {
    const label = t('theme', language) + ': ' + t('theme.' + theme, language);
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

function applyLanguage(next, persist = false) {
  language = next === 'zh' ? 'zh' : 'en';
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  if (persist) {
    write(LANG_KEY, language);
    const url = new URL(location.href);
    url.searchParams.set('lang', language);
    history.replaceState(null, '', url);
  }
  document.querySelectorAll('[data-i18n]').forEach(el => { if (copy[el.dataset.i18n]) el.textContent = t(el.dataset.i18n, language); });
  document.querySelectorAll('[data-i18n-alt]').forEach(el => { el.alt = t(el.dataset.i18nAlt, language); });
  document.querySelectorAll('[data-language]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.language === language)));
  const description = document.querySelector('meta[name="description"]');
  const descriptionKey = document.body.dataset.docs ? 'docs.description' : 'site.description';
  if (description && copy[descriptionKey]) description.content = t(descriptionKey, language);
  if (!document.body.dataset.docs) document.title = t('site.title', language);
  applyTheme();
  for (const listener of listeners) listener(language);
}

document.querySelectorAll('[data-language]').forEach(button => {
  button.disabled = false;
  button.addEventListener('click', () => applyLanguage(button.dataset.language, true));
});
document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  theme = ['system', 'light', 'dark'][(['system', 'light', 'dark'].indexOf(theme) + 1) % 3];
  write(THEME_KEY, theme);
  applyTheme();
});
document.querySelectorAll('[data-site-control]').forEach(button => { button.disabled = false; });
dark.addEventListener?.('change', () => { if (theme === 'system') applyTheme(); });
applyLanguage(language);

document.querySelectorAll('[data-copy-target]').forEach(button => {
  button.disabled = false;
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    const status = document.getElementById(button.dataset.copyStatus || '');
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent);
      if (status) status.textContent = t('copied', language);
    } catch {
      if (status) status.textContent = t('copy.failed', language);
    }
  });
});

// Keep published documentation section links useful after the information redesign.
const legacySections = {
  'welcome-what': 'welcome', 'welcome-cando': 'desktop', 'welcome-entries': 'install',
  'welcome-quick': 'desktop', 'welcome-chain': 'permissions',
  'install-what': 'install', 'install-platforms': 'install', 'install-desktop': 'install',
  'install-cli': 'cli', 'install-env': 'install', 'install-source': 'install',
  'desktop-first': 'desktop', 'desktop-layout': 'desktop', 'desktop-modes': 'faq-goal',
  'evidence-contains': 'evidence', 'evidence-use': 'evidence',
  'perm-why': 'permissions', 'perm-ask': 'permissions', 'perm-cli': 'permissions',
  'faq-share': 'permissions', 'faq-upload': 'permissions', 'faq-helper': 'cli-start',
  'faq-cli-plat': 'install', 'faq-support': 'faq',
};
function resolveLegacyHash() {
  const value = location.hash.slice(1);
  const [page, section] = value.split('/');
  const alias = legacySections[section || page];
  const target = (section && document.getElementById(section)) ||
    (alias && document.getElementById(alias)) || document.getElementById(page);
  if (!section && !alias) return;
  if (target) {
    history.replaceState(null, '', '#' + target.id);
    target.scrollIntoView();
  }
}
window.addEventListener('hashchange', resolveLegacyHash);
resolveLegacyHash();
