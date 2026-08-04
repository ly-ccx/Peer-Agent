import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const componentSource = readFileSync(new URL('./VersionBadge.tsx', import.meta.url), 'utf8');
const updaterStyles = readFileSync(new URL('../../styles/updater.css', import.meta.url), 'utf8');

test('available updates use a styled icon instead of exposing an i18n key', () => {
  assert.match(componentSource, /className="sidebar-version-update-icon"/);
  assert.match(
    componentSource,
    /className="sidebar-version-update-icon"[\s\S]*?<svg[\s\S]*?aria-hidden="true"/,
  );
  assert.doesNotMatch(componentSource, /updater\.badge\.newTag/);
  assert.doesNotMatch(componentSource, /sidebar-version-new-tag/);
  assert.match(updaterStyles, /\.sidebar-version-update-icon\s*\{/);
});

test('the version badge renders a styled tag only for Vite development builds', () => {
  assert.match(
    componentSource,
    /\{import\.meta\.env\.DEV \? \([\s\S]*?className="sidebar-version-dev-tag"[\s\S]*?开发[\s\S]*?\) : null\}/,
  );
  assert.match(updaterStyles, /\.sidebar-version-dev-tag\s*\{/);
});
