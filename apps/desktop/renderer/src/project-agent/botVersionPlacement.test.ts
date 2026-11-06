import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync(new URL('./BotListShell.tsx', import.meta.url), 'utf8');
const badge = readFileSync(new URL('../app/components/VersionBadge.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles/bot-list.css', import.meta.url), 'utf8');

test('the bot list puts the version under Peer and the upgrade control left of new', () => {
  assert.match(shell, /className="bot-brand-copy"[\s\S]*className="bot-brand-name"[\s\S]*variant="bot-subtitle"/);
  assert.match(shell, /variant="bot-upgrade"[\s\S]*className="bot-new"/);
  assert.doesNotMatch(shell, /metadata=\{<VersionBadge/);
  assert.doesNotMatch(shell, /variant="bot-footer"/);
  assert.match(badge, /variant === 'bot-subtitle'/);
  assert.match(badge, /className="sidebar-version-badge bot-version-subtitle"/);
  assert.match(badge, /className=\{`bot-upgrade/);
  assert.match(badge, /className="bot-upgrade-value"/);
  assert.match(badge, /isReady \? \(\s*i18n\.t\('updater\.badge\.install'\)/);
  assert.match(badge, /name=\{isError \? 'warning' : 'arrowDown'\}/);
  assert.match(css, /\.bot-brand-copy\s*\{/);
  assert.match(css, /\.bot-version-subtitle\s*\{/);
  assert.match(css, /\.bot-upgrade\.is-progress\s*,/);
  assert.match(css, /\.bot-upgrade\.is-install\s*,/);
  assert.match(css, /conic-gradient\(from -90deg/);
  assert.doesNotMatch(css, /\.bot-column-footer \.sidebar-version-badge/);
});
