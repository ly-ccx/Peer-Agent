import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./GlobalWorkbenchPage.tsx', import.meta.url), 'utf8');
const readStyles = () =>
  readFile(new URL('../../styles/global-workbench.css', import.meta.url), 'utf8');

test('global workbench acceptance waits for success before celebrating and freezes order snapshot', async () => {
  const source = await readPage();
  assert.match(source, /mergeAcceptanceTransitionItems/);
  assert.match(source, /ACCEPTANCE_CELEBRATION_MS/);
  assert.match(source, /ACCEPTANCE_EXIT_MS/);
  assert.match(source, /await onAcceptResult\(item\);[\s\S]*phase: 'celebrating'/);
  assert.match(source, /setAcceptanceOrderSnapshot\(resultReady\.map\(\(candidate\) => candidate\.taskId\)\)/);
  assert.match(source, /orderSnapshot: acceptanceOrderSnapshot/);
  assert.match(source, /gwb-item--\$\{phase\}/);
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

test('global workbench acceptance celebration styles cover three phases and reduced motion', async () => {
  const styles = await readStyles();
  assert.match(styles, /\.gwb-item--submitting/);
  assert.match(styles, /\.gwb-item--celebrating/);
  assert.match(styles, /\.gwb-item--exiting/);
  assert.match(styles, /gwb-item-celebrate-pop/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.gwb-accept-spinner/);
});
