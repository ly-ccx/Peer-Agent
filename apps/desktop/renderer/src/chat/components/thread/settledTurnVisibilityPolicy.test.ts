import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const timelineStyles = readFileSync(new URL('../../styles/timeline.css', import.meta.url), 'utf8');

test('settled turns do not defer layout work into scroll frames when explicit virtualization is off', () => {
  assert.doesNotMatch(
    timelineStyles,
    /\.chat-turn-virtual-list:not\(\[data-virtualized='true'\]\)[\s\S]*?content-visibility:\s*auto/,
  );
  assert.doesNotMatch(
    timelineStyles,
    /\.chat-turn-virtual-list:not\(\[data-virtualized='true'\]\)[\s\S]*?contain-intrinsic-size:/,
  );
});
