import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../styles/chat-surface.css', import.meta.url), 'utf8');

test('home control strip keeps a compact left-group gap', () => {
  // + button sits beside the model/thinking/context cluster.
  assert.match(
    styles,
    /\.composer-home-action-left \{[\s\S]*?gap:\s*2px;/,
  );
});

test('source and isolation sit above the composer card', () => {
  assert.match(
    styles,
    /\.composer-context-row \{[\s\S]*?margin:\s*0 auto 4px;/,
  );
  assert.match(
    styles,
    /\.chat-composer-wrap--empty-home \.composer-context-row \{[\s\S]*?margin:\s*0 auto 6px;/,
  );
});

test('workspace picker stays in the toolbar under the composer', () => {
  assert.match(
    styles,
    /\.chat-composer-toolbar \{[\s\S]*?margin:\s*var\(--space-2\) auto 0;/,
  );
});

test('home composer textarea keeps a taller empty-state input area', () => {
  assert.match(
    styles,
    /\.chat-composer--home \{[\s\S]*?grid-template-rows:\s*minmax\(96px,\s*1fr\)\s+auto;[\s\S]*?min-height:\s*178px;/,
  );
  assert.match(
    styles,
    /\.chat-composer--home > textarea \{[\s\S]*?min-height:\s*96px;[\s\S]*?max-height:\s*240px;/,
  );
  // Compact thread composer stays capped; shared home/compact selector no longer sets 160px.
  assert.match(
    styles,
    /\.chat-composer--compact > textarea \{[\s\S]*?max-height:\s*160px;/,
  );
  assert.doesNotMatch(
    styles,
    /\.chat-composer--home > textarea,\s*\.chat-composer--compact > textarea \{[^}]*max-height:\s*160px;/,
  );
});

test('home action row bottom-aligns left controls with the send button', () => {
  // Shorter model/thinking/context chips should sit on the same baseline edge as the taller submit button.
  assert.match(
    styles,
    /\.composer-home-action-row \{[\s\S]*?align-items:\s*flex-end;/,
  );
});

test('home model slot packs model/thinking/context tightly', () => {
  // Short labels stay dense; the current home treatment uses a 2px internal gap and 8px horizontal padding.
  assert.match(
    styles,
    /\.composer-home-model-slot \.token-usage-wrap,[\s\S]*?\.composer-home-model-slot \.token-usage \{[\s\S]*?gap:\s*2px;/,
  );
  assert.match(
    styles,
    /\.composer-home-model-slot \.pa-cascading-trigger,[\s\S]*?padding:\s*0 8px;/,
  );
  assert.match(
    styles,
    /\.composer-home-model-slot \.token-usage-context-window \{[\s\S]*?padding:\s*0 8px;/,
  );
});

test('home model slot uses control-level font size, not body', () => {
  // Auxiliary model/thinking/context labels should read as controls, not body copy.
  assert.match(
    styles,
    /\.composer-home-model-slot \.token-usage-wrap,[\s\S]*?\.composer-home-model-slot \.token-usage \{[\s\S]*?font-size:\s*var\(--composer-addon-font-size/,
  );
  assert.match(
    styles,
    /\.composer-home-model-slot \.pa-cascading-trigger,[\s\S]*?font-size:\s*var\(--composer-addon-font-size/,
  );
  assert.match(
    styles,
    /\.composer-home-model-slot \.token-usage-context-window \{[\s\S]*?font-size:\s*var\(--composer-addon-font-size/,
  );
  assert.doesNotMatch(
    styles,
    /\.composer-home-model-slot[\s\S]{0,800}?font-size:\s*var\(--ui-font-body/,
  );
});
