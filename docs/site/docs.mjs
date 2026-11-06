import { docsCopy } from './docs-copy.mjs';
import { referenceCopy } from './reference-copy.mjs';
import { registerCopy, onLanguage } from './site.mjs';

const english = new Map([...document.querySelectorAll('[data-ref-key]')].map(el => [el.dataset.refKey, el.innerHTML]));
registerCopy(docsCopy);
onLanguage(lang => {
  document.title = (lang === 'zh' ? 'Peer 使用文档' : 'Peer documentation');
  document.querySelectorAll('[data-ref-key]').forEach(el => {
    const key = el.dataset.refKey;
    // Both dictionaries are bundled project copy; external content never enters this path.
    el.innerHTML = referenceCopy[lang]?.[key] ?? english.get(key) ?? el.innerHTML;
  });
});
document.querySelectorAll('[data-page-link]').forEach(link => {
  link.href = '#' + link.dataset.pageLink;
});
