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
