import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createWebEntryPromptSource,
  renderWebEntryPrompt,
} from './web-entry-source.mjs';

test('web entry source always admits the L1 default-entry rule', () => {
  const source = createWebEntryPromptSource();
  assert.equal(source.id, 'runtime.web-entry');
  assert.equal(source.layer, 'L5_TOOL_RULES');
  assert.deepEqual(source.observe({}), { available: true });

  const sections = source.render(source.observe({}));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'runtime.web-entry');
  assert.equal(sections[0].layer, 'L5_TOOL_RULES');
  assert.match(sections[0].content, /browser_\*/);
  assert.match(sections[0].content, /browser_external_\*/);
  assert.match(sections[0].content, /ADR 72/);
  assert.match(sections[0].content, /Do not open Playwright/);
  assert.doesNotMatch(sections[0].content, /delete browser_external/);
});

test('web entry prompt names in-app tools and keeps L2 explicit', () => {
  const content = renderWebEntryPrompt();
  assert.match(content, /browser_open_panel/);
  assert.match(content, /browser_click/);
  assert.match(content, /separate profile|isolated Chromium/i);
  assert.match(content, /Never attach the in-app webview/);
});
