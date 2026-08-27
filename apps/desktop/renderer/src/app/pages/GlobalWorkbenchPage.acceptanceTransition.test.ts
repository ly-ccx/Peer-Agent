import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./GlobalWorkbenchPage.tsx', import.meta.url), 'utf8');
const readPanel = () =>
  readFile(new URL('../components/SourceCheckoutPanel.tsx', import.meta.url), 'utf8');
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

test('global workbench main column no longer hosts leftover acceptance snapshots', async () => {
  const source = await readPage();
  assert.doesNotMatch(source, /mergeAcceptanceTransitionItems/);
  assert.doesNotMatch(source, /ACCEPTANCE_CELEBRATION_MS/);
  assert.doesNotMatch(source, /setAcceptanceOrderSnapshot/);
  assert.doesNotMatch(source, /resultReady/);
  assert.doesNotMatch(source, /handleAccept/);
  assert.doesNotMatch(source, /kind="accept"/);
  assert.match(source, /kind="need"/);
  assert.match(source, /className="gwb-type"/);
  assert.match(source, /className="gwb-body"/);
  assert.match(source, /className="gwb-chips"/);
  assert.match(source, /className="gwb-chip gwb-chip-ws"/);
  assert.doesNotMatch(source, /gwb-tag-col|gwb-item-main|gwb-meta/);
  assert.doesNotMatch(source, /先看依据/);
  assert.doesNotMatch(source, /确认验收/);
});

test('source env-block cards expand in place and do not open a conversation', async () => {
  const source = await readPage();
  const panel = await readPanel();
  const styles = await readStyles();
  assert.match(source, /deliveryHandoffStoppedReason/);
  assert.match(source, /isSourceEnvBlock/);
  assert.match(source, /SourceCheckoutPanel/);
  assert.match(source, /处理源头/);
  assert.match(source, /源头有未提交的改动/);
  assert.match(source, /if \(isSourceEnvBlock\(item\)\) return;/);
  assert.match(source, /gwb-item--source-open/);
  assert.match(source, /sourceBlock && sourceOpen \? <SourceCheckoutPanel item=\{item\} \/>/);
  assert.match(panel, /workspacePath/);
  assert.match(panel, /committed\?\.detail/);
  assert.match(panel, /disabled=\{busy \|\| !canRetry\}/);
  assert.doesNotMatch(panel, /blockedPlanTitles/);
  assert.doesNotMatch(panel, /unavailable/);
  assert.match(styles, /\.source-checkout-panel\s*\{[\s\S]*grid-column:\s*1\s*\/\s*-1/);
  assert.doesNotMatch(styles, /\.source-checkout-panel\s*\{[\s\S]*#9a7340/);
});

test('global workbench pulse and empty radar do not revive an accept bucket', async () => {
  const source = await readPage();
  assert.doesNotMatch(source, /catch \{[\s\S]*delete next\[item\.taskId\]/);
  assert.doesNotMatch(source, /actionRight === 'result_ready'\) row\.accept/);
  assert.match(source, /gwb-layout--empty/);
  assert.match(source, /kind="need"/);
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
  assert.match(source, /<ThinkingOrb\s+state="weaving"\s+size=\{20\}/);
  assert.match(source, /className="gwb-run-pct" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /key=\{`\$\{item\.planProgress\.completed\}\/\$\{item\.planProgress\.total\}`\}/);
  assert.match(source, /className="gwb-run-pct-value"/);

  const styles = await readStyles();
  assert.match(styles, /animation: gwb-run-count-change 280ms/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.gwb-run-dot[\s\S]*\.gwb-run-pct-value/,
  );
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

test('empty radar stretches the main column and keeps the side ambient', async () => {
  const source = await readPage();
  const styles = await readStyles();

  assert.match(source, /className=\{`gwb-layout\$\{showEmpty \? ' gwb-layout--empty' : ''\}`\}/);
  assert.match(source, /现在没有需要你处理的事/);
  assert.match(source, /Peer 正在推进 \{advancing\.length\} 个任务，你可以离开。/);
  assert.match(source, /雷达是安静的。其余由 Peer 推进。/);
  assert.doesNotMatch(source, /个任务由 Peer 推进中/);

  assert.match(styles, /\.gwb-layout--empty\s*\{[\s\S]*items-stretch/);
  assert.match(styles, /\.gwb-empty\s*\{[\s\S]*flex-1[\s\S]*min-height:\s*310px/);
  assert.doesNotMatch(source, /gwb-calm-card|gwb-calm-title|gwb-calm-dot/);
});

test('workspace pulse aggregates need and run only, not leftover acceptance', async () => {
  const source = await readPage();
  const styles = await readStyles();

  assert.match(source, /new Map<string, \{ need: number; run: number \}>/);
  assert.match(source, /total: counts\.need \+ counts\.run/);
  assert.match(source, /\{row\.need\} 需你/);
  assert.match(source, /\{row\.run\} 推进/);
  assert.doesNotMatch(source, /row\.accept|\{row\.accept\} 验收/);
  assert.doesNotMatch(source, /actionRight === 'result_ready'\) row\.accept/);
  assert.doesNotMatch(styles, /\.gwb-num-ok/);
  assert.match(styles, /grid-template-columns:\s*1\.4fr repeat\(2, 0\.8fr\)/);
  assert.doesNotMatch(styles, /repeat\(3,/);
});
