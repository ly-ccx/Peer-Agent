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
