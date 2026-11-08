import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, selector);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${selector}`);
}

test('an unread empty conversation centers its reading placeholder', () => {
  const view = read('./BotMessageList.tsx');
  const css = read('../styles/bot-conversation.css');
  assert.match(view, /data-reading=\{rows\.length === 0 && !ready \? 'true' : undefined\}/);
  assert.match(view, /bot-thread-empty\$\{ready \? '' : ' is-reading'\}/);
  assert.match(view, /className=\{ready \? undefined : 'bot-reading-shimmer'\}/);
  assert.doesNotMatch(view, /peer-preview-reading|localStorage/);

  const thread = block(css, '.bot-thread[data-reading="true"]');
  const empty = block(css, '.bot-thread[data-reading="true"] > .bot-thread-empty');
  assert.match(thread, /justify-content:\s*center/);
  assert.match(thread, /padding-block:\s*0/);
  assert.match(empty, /flex-grow:\s*1/);
  assert.match(empty, /justify-content:\s*center/);
  assert.doesNotMatch(empty, /margin-top|top:\s*\d/);
});

test('the reading label uses typography tokens and a visible theme-aware sweep', () => {
  const css = read('../styles/bot-conversation.css');
  const hero = block(css, '.bot-thread-empty.is-reading .bot-reading-shimmer');
  const shimmer = block(css, '.bot-reading-shimmer');
  assert.match(hero, /font-size:\s*var\(--ui-font-heading-md\)/);
  assert.match(hero, /font-weight:\s*600/);
  assert.match(hero, /line-height:\s*var\(--ui-line-tight\)/);
  assert.doesNotMatch(hero, /font-size:\s*\d+px/);
  assert.match(shimmer, /animation:\s*motion-shimmer 2\.2s linear infinite/);
  assert.match(shimmer, /--motion-shimmer-from:\s*110%/);
  assert.match(shimmer, /--motion-shimmer-x:\s*-10%/);
  assert.match(shimmer, /--reading-sheen:\s*color-mix\(in srgb, var\(--graphite-base\) 72%, black\)/);
  assert.match(css, /\[data-theme="dark"\] \.bot-reading-shimmer\s*\{[^}]*--reading-sheen:\s*color-mix\(in srgb, var\(--graphite-base\) 30%, white\)/);
  assert.match(css, /\[data-theme="dark"\] \.bot-thread-empty\.is-reading \.bot-reading-shimmer\s*\{[^}]*--reading-ink:\s*var\(--graphite-fade\)/);

  assert.match(css, /\.bot-reading-shimmer,\s*\n\s*\.bot-process-current\.is-running,[\s\S]*?animation:\s*none;/);
  assert.match(css, /\.bot-reading-shimmer \{\s*background:\s*none;\s*-webkit-text-fill-color:\s*currentColor;\s*color:\s*var\(--reading-ink, var\(--graphite-soft\)\);\s*\}/);
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.bot-reading-shimmer \{\s*background:\s*none;\s*-webkit-text-fill-color:\s*CanvasText;\s*color:\s*CanvasText;\s*animation:\s*none;\s*\}/);
});

test('compact reading notes share the sweep without the hero scale', () => {
  const work = read('./BotWorkPanel.tsx');
  const draft = read('./InputRecoveryNotice.tsx');
  const reply = read('./ReplyContext.tsx');
  const css = read('../styles/bot-conversation.css');
  const panel = read('../styles/bot-work-panel.css');
  assert.match(work, /className="bot-work-panel-note bot-reading-shimmer"/);
  assert.match(draft, /className="bot-draft-status" role="status"><span className="bot-reading-shimmer">/);
  assert.match(reply, /bot-thinking-status-label/);
  assert.doesNotMatch(reply, /bot-reading-shimmer/);
  const hero = block(css, '.bot-thread-empty.is-reading .bot-reading-shimmer');
  assert.doesNotMatch(hero, /bot-work-panel-note|bot-draft-status/);
  assert.match(panel, /\[data-work-panel-open="true"\]\[data-work-panel-wide="false"\] \.bot-thread\[data-reading="true"\]/);
  assert.match(panel, /padding-inline-end:/);
});
