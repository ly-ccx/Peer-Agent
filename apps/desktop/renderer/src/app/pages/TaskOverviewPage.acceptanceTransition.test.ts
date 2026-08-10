import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');
const readApp = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');

test('result acceptance waits for success before celebrating and preserves a removal snapshot', async () => {
  const source = await readPage();
  assert.match(source, /type AcceptancePhase = 'submitting' \| 'celebrating' \| 'exiting'/);
  assert.match(source, /await onAcceptResult\(item\);[\s\S]*phase: 'celebrating'/);
  assert.match(source, /Object\.values\(acceptanceTransitions\)/);
  assert.match(source, /result-card--\$\{phase\}/);
  assert.match(source, /正在验收…/);
  assert.match(source, /验收完成，任务已圆满结束/);
});

test('acceptance transitions reinsert cards at their original orderIndex instead of appending', async () => {
  const source = await readPage();
  assert.match(source, /readonly orderIndex: number/);
  assert.match(source, /resultReady\.findIndex\(\(candidate\) => candidate\.taskId === item\.taskId\)/);
  assert.match(source, /\.sort\(\(a, b\) => a\.orderIndex - b\.orderIndex\)/);
  assert.match(source, /working\.splice\(insertAt, 0, transition\.item\)/);
  assert.doesNotMatch(
    source,
    /const displayedResults = \[\s*\.\.\.resultReady,\s*\.\.\.Object\.values\(acceptanceTransitions\)/,
  );
});

test('a failed acceptance returns the card to a retryable idle state', async () => {
  const [source, app] = await Promise.all([readPage(), readApp()]);
  assert.match(source, /catch \{[\s\S]*delete next\[item\.taskId\]/);
  assert.match(source, /disabled=\{!canAccept \|\| Boolean\(phase\)\}/);
  assert.match(app, /accept result failed'[\s\S]*throw error/);
});

test('acceptance celebration has smoother timing and a reduced-motion fallback', async () => {
  const [source, styles] = await Promise.all([readPage(), readStyles()]);
  assert.match(source, /const ACCEPTANCE_CELEBRATION_MS = 980/);
  assert.match(source, /const ACCEPTANCE_EXIT_MS = 420/);
  assert.match(styles, /result-card-celebrate-lift/);
  assert.match(styles, /opacity 420ms cubic-bezier\(0\.33, 0, 0\.2, 1\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.result-card-celebration \{ display: none; \}/);
  assert.match(styles, /\.result-card--exiting/);
});
