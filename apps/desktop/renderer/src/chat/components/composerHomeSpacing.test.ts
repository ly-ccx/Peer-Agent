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

test('composer chrome keeps Goal left and environment right, or Goal centered without Git', () => {
  assert.match(
    styles,
    /\.composer-chrome-row:has\(\.composer-chrome-right:not\(:empty\)\) \{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*auto\);/,
  );
  assert.match(
    styles,
    /\.composer-chrome-row:not\(:has\(\.composer-chrome-right:not\(:empty\)\)\) \{[\s\S]*?grid-template-columns:\s*1fr auto 1fr;/,
  );
  assert.doesNotMatch(
    styles,
    /\.composer-chrome-row \{[^}]*grid-template-columns:\s*1fr auto 1fr;/,
  );
  assert.doesNotMatch(
    styles,
    /\.composer-chrome-row \{[^}]*justify-content:\s*center;/,
  );
  assert.match(
    styles,
    /\.composer-chrome-left \{[\s\S]*?justify-self:\s*start;/,
  );
  assert.match(
    styles,
    /\.composer-chrome-row:not\(:has\(\.composer-chrome-right:not\(:empty\)\)\) \.composer-chrome-left \{[\s\S]*?justify-self:\s*center;/,
  );
  assert.match(
    styles,
    /\.composer-chrome-right \{[\s\S]*?justify-self:\s*end;/,
  );
  assert.match(
    styles,
    /\.composer-chrome-left > \.goal-panel--docked \{[\s\S]*?width:\s*auto;/,
  );
  assert.match(
    styles,
    /\.chat-composer-wrap--empty-home \.composer-chrome-row \{[\s\S]*?margin:\s*0 auto 8px;/,
  );
});

test('env capsule pins to the right chrome column', () => {
  assert.match(
    styles,
    /\.composer-chrome-right \{[\s\S]*?justify-self:\s*end;[\s\S]*?gap:\s*var\(--space-2\);/,
  );
  assert.match(
    styles,
    /\.composer-chrome-right \.composer-env-capsule \{\n  flex-shrink:\s*1;\n\}/,
  );
  assert.match(
    styles,
    /\.chat-composer-wrap--empty-home \.composer-chrome-right \.composer-env-capsule \{\n  flex-shrink:\s*1;\n\}/,
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
    /\.chat-composer--home > textarea \{[\s\S]*?min-height:\s*96px;/,
  );
  assert.match(
    styles,
    /\.chat-composer textarea \{[\s\S]*?field-sizing:\s*content;[\s\S]*?max-height:\s*20lh;[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  // Home and compact share the 20-line cap so neither stays locked to one overflowing row.
  assert.match(
    styles,
    /\.chat-composer--home > textarea,\s*\.chat-composer--compact > textarea \{[\s\S]*?max-height:\s*20lh;[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.match(
    styles,
    /\.chat-composer--compact > textarea \{[\s\S]*?min-height:\s*28px;/,
  );
  assert.doesNotMatch(
    styles,
    /\.chat-composer--compact > textarea \{[\s\S]*?max-height:\s*160px;/,
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
