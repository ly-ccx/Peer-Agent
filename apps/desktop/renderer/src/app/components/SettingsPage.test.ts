import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../styles/settings-page.css', import.meta.url), 'utf8');

test('settings header back control includes the title in the same button', () => {
  assert.match(
    source,
    /<button type="button" onClick=\{onBack\} aria-label=\{i18n\.t\('app\.settings'\)\}>[\s\S]*?<strong>\{i18n\.t\('app\.settings'\)\}<\/strong>\s*<\/button>/,
  );
  assert.doesNotMatch(source, /<\/button>\s*<strong>\{i18n\.t\('app\.settings'\)\}<\/strong>/);
  assert.match(css, /\.settings-nav-header button \{[\s\S]*gap:\s*var\(--space-3\)/);
  assert.match(css, /\.settings-nav-header button \{[\s\S]*-webkit-app-region:\s*no-drag/);
});
