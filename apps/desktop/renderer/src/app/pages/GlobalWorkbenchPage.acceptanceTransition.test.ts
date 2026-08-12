import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./GlobalWorkbenchPage.tsx', import.meta.url), 'utf8');
const readStyles = () =>
  readFile(new URL('../../styles/global-workbench.css', import.meta.url), 'utf8');

test('advancing count has one overview entry and no duplicate hero summary', async () => {
  const source = await readPage();
  const styles = await readStyles();

  assert.match(
    source,
    /<span className="gwb-side-label">PEER 推进<\/span>\s*<span className="gwb-side-count">\{advancing\.length\} 个任务<\/span>/,
  );
  assert.doesNotMatch(source, /个任务在推进|gwb-calm-card|gwb-calm-title|gwb-calm-dot/);
  assert.doesNotMatch(styles, /\.gwb-calm-card|\.gwb-calm-title|\.gwb-calm-dot/);
});

test('global workbench renders action arrows as decorative svg icons', async () => {
  const source = await readPage();
  const styles = await readStyles();

  assert.match(source, /item\.nextAction === 'decide_blocked'/);
  assert.match(source, /function ActionArrowIcon\(\)/);
  assert.match(source, /className="gwb-btn-arrow"/);
  assert.match(source, /<path d="M5 12h14M13 6l6 6-6 6" \/>/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(styles, /\.gwb-btn-arrow/);
});

test('global workbench acceptance waits for success before celebrating and freezes order snapshot', async () => {
  const source = await readPage();
  assert.match(source, /mergeAcceptanceTransitionItems/);
  assert.match(source, /ACCEPTANCE_CELEBRATION_MS/);
  assert.match(source, /ACCEPTANCE_EXIT_MS/);
  assert.match(source, /await onAcceptResult\(item\);[\s\S]*phase: 'celebrating'/);
  assert.match(source, /setAcceptanceOrderSnapshot\(resultReady\.map\(\(candidate\) => candidate\.taskId\)\)/);
  assert.match(source, /orderSnapshot: acceptanceOrderSnapshot/);
  assert.match(source, /ParticleShatterOverlay/);
  assert.match(source, /is-shattering/);
  assert.match(source, /is-exiting/);
  assert.match(source, /className="gwb-type"/);
  assert.match(source, /className="gwb-body"/);
  assert.match(source, /className="gwb-chips"/);
  assert.match(source, /className="gwb-chip gwb-chip-ws"/);
  assert.doesNotMatch(source, /gwb-tag-col|gwb-item-main|gwb-meta/);
  assert.match(source, /正在验收…/);
  assert.match(source, /已验收 ✓/);
  assert.doesNotMatch(
    source,
    /onAccept=\{\s*onAcceptResult\s*\?\s*\(\)\s*=>\s*\{\s*void onAcceptResult\(item\);/,
  );
});

test('global workbench acceptance failure returns the card to a retryable idle state', async () => {
  const source = await readPage();
  assert.match(source, /catch \{[\s\S]*delete next\[item\.taskId\]/);
  assert.match(source, /disabled=\{acceptBusy\}/);
});

test('global workbench removes the final divider through the shatter host wrapper', async () => {
  const source = await readPage();
  assert.match(
    source,
    /className=\{`particle-shatter-host[\s\S]*>\s*<div\s+ref=\{cardRef\}\s+className=\{`gwb-item /,
  );

  const styles = await readStyles();
  assert.match(styles, /\.gwb-list\s*>\s*:last-child\s*>\s*\.gwb-item\s*\{[\s\S]*border-b-0/);
  assert.doesNotMatch(styles, /\.gwb-item:last-child\s*\{/);
});

test('advancing tasks animate the running ring and progress changes accessibly', async () => {
  const source = await readPage();
  assert.match(source, /className="gwb-run-dot"/);
  assert.match(source, /className="gwb-run-pct" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /key=\{`\$\{item\.planProgress\.completed\}\/\$\{item\.planProgress\.total\}`\}/);
  assert.match(source, /className="gwb-run-pct-value"/);

  const styles = await readStyles();
  assert.match(styles, /animation: gwb-run-spin 900ms linear infinite/);
  assert.match(styles, /animation: gwb-run-count-change 280ms/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.gwb-run-dot[\s\S]*\.gwb-run-pct-value/);
});

test('global workbench acceptance uses particle shatter overlay styles', async () => {
  const source = await readPage();
  assert.match(source, /ParticleShatterOverlay/);
  assert.match(source, /particle-shatter-source/);
  const shatterStyles = await readFile(
    new URL('../../styles/particle-shatter.css', import.meta.url),
    'utf8',
  );
  assert.match(shatterStyles, /particle-shatter-canvas/);
  assert.match(shatterStyles, /is-shattering/);
  assert.match(shatterStyles, /is-exiting/);
  assert.match(shatterStyles, /max-height/);
  assert.match(shatterStyles, /@media \(prefers-reduced-motion: reduce\)/);
  const styles = await readStyles();
  assert.match(styles, /\.gwb-item--submitting/);
  assert.match(styles, /\.gwb-accept-spinner/);
});
