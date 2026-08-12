import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  const bodyStart = css.indexOf('{', start) + 1;
  const end = css.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `unterminated ${selector}`);
  return css.slice(bodyStart, end);
}

test('task and history search controls share a clear icon and non-pill geometry', async () => {
  const [css, tasksPage, historyPage] = await Promise.all([
    readFile(new URL('./task-overview.css', import.meta.url), 'utf8'),
    readFile(new URL('../app/pages/TasksPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/pages/HistoryPage.tsx', import.meta.url), 'utf8'),
  ]);

  const searchBox = ruleBody(css, '.task-search-box');
  const searchIcon = ruleBody(css, '.task-search-box__icon');

  assert.match(searchBox, /min-height:\s*2\.75rem/);
  assert.match(searchBox, /border-radius:\s*1rem/);
  assert.doesNotMatch(searchBox, /rounded-full/);
  assert.match(searchIcon, /width:\s*1rem/);
  assert.match(searchIcon, /height:\s*1rem/);
  assert.match(searchIcon, /stroke-width:\s*1\.75/);

  for (const page of [tasksPage, historyPage]) {
    assert.match(page, /className="task-search-box__icon"/);
    assert.match(page, /<circle cx="11" cy="11" r="6\.5" \/>/);
    assert.doesNotMatch(page, />⌕<\/span>/);
  }
});
