import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const readText = (path) => readFile(new URL(path, root), 'utf8');
const readJson = async (path) => JSON.parse(await readText(path));

test('v0.0.3 changelog data preserves release-note heading hierarchy', async () => {
  const entry = await readJson('docs/changelog-data/v0.0.3.json');
  const sectionTitles = entry.zh.map((section) => section.title);
  assert.deepEqual(sectionTitles, ['说明', '主要变化', '升级建议']);

  const highlights = entry.zh.find((section) => section.title === '主要变化');
  assert.deepEqual(
    highlights.subsections.map((subsection) => subsection.title),
    ['Agent 任务流', 'Workbench 与交互', '发布与文档'],
  );
  assert.equal(highlights.items.length, 0);
  assert.equal(
    highlights.subsections.some((subsection) =>
      subsection.items.some((item) => item.includes(`**${subsection.title}**`)),
    ),
    false,
  );

  const englishTitles = entry.en.map((section) => section.title);
  assert.deepEqual(englishTitles, ['Overview', 'Highlights', 'Upgrade']);
  assert.deepEqual(
    entry.en.find((section) => section.title === 'Highlights').subsections.map(({ title }) => title),
    ['Agent workflow', 'Workbench and interaction', 'Release and documentation'],
  );
});

test('legacy release notes without subheadings remain list sections', async () => {
  const entry = await readJson('docs/changelog-data/v0.0.1-beta.10.json');
  assert(entry.zh.length > 0);
  assert(entry.zh.some((section) => section.items.length > 0));
  for (const section of entry.zh) assert.equal(section.subsections, undefined);
});

test('web changelog renders original section titles and nested subsections', async () => {
  const html = await readText('docs/changelog.html');
  assert.match(html, /h3\.textContent = sec\.title \|\|/);
  assert.match(html, /\(sec\.subsections \|\| \[\]\)\.forEach/);
  assert.match(html, /h4\.textContent = subsection\.title/);
  assert.doesNotMatch(html, /h3\.textContent = \(LABELS\[state\.lang\]/);
});

test('changelog manifest carries a real generatedAt, never the epoch placeholder', async () => {
  const manifest = await readJson('docs/changelog-data/manifest.json');
  assert.notEqual(manifest.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)), `generatedAt is not a valid timestamp: ${manifest.generatedAt}`);
});
