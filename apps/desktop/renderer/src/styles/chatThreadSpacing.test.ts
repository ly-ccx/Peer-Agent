import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stylesDir = dirname(fileURLToPath(import.meta.url));
const chatSurfaceCss = readFileSync(join(stylesDir, '../chat/styles/chat-surface.css'), 'utf8');

function ruleBody(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('chat thread keeps visual spacing below the floating header', () => {
  const expectedTopPadding = /padding-top:\s*calc\(40px \+ var\(--space-4\)\)/;

  assert.match(ruleBody(chatSurfaceCss, '.chat-thread'), expectedTopPadding);
  assert.match(
    ruleBody(chatSurfaceCss, '.app-shell.is-fullscreen .chat-thread'),
    expectedTopPadding,
  );
});

/**
 * 回归护栏：「内容与输入框之间那段空白」的成因。
 *
 * 轮次间距已经下沉到 .chat-turn 的 padding-bottom（timeline.css 里注明「原 chat-thread
 * 的轮次间距移入测量盒」），.chat-composer-wrap 另有 8px 顶部内边距。若 .chat-thread 再
 * 追加一份底部 padding，三者会叠加成约 64px 的死区——正是用户反馈的那段空白。
 *
 * 所以这里锁住：.chat-thread 的底部内边距必须是 0。
 */
test('chat thread does not re-add bottom padding (turn spacing already provides it)', () => {
  const body = ruleBody(chatSurfaceCss, '.chat-thread');

  // padding 简写里第 1 个值（上）与第 3 个值（下）都必须为 0；只允许左右有值。
  const shorthand = body.match(/padding:\s*([^;]+);/);
  assert.ok(shorthand, 'expected a padding shorthand on .chat-thread');
  const parts = shorthand[1].split(/\s+/);
  assert.equal(parts[0], '0', `expected zero top in the shorthand, got ${parts[0]}`);
  const bottom = parts[2] ?? parts[0];
  assert.equal(bottom, '0', `expected zero bottom padding on .chat-thread, got ${bottom}`);

  // 顶部由 padding-top 覆盖，仍需保留（另一条契约断言了它的具体值）。
  assert.match(body, /padding-top:\s*calc\(40px \+ var\(--space-4\)\)/);
  assert.doesNotMatch(
    body,
    /padding:\s*var\(--space-8\)/,
    'the vertical --space-8 shorthand is what created the double gap; keep it out',
  );
});

/**
 * 「子任务遮住输出」的回归护栏。
 *
 * 后台调查浮层（.goal-investigation）是 `position: absolute` + `bottom: calc(100% + 12px)`，
 * 悬在输入框上方、不占布局。所以正文底部必须按它的可见性留出净空：可见时留、不可见时不留。
 * 两个方向都要锁住——常驻会产生死区（用户反馈的空白），缺失则会被浮层盖住（用户反馈的遮挡）。
 */
test('investigation floating layer reserves bottom clearance only while visible', () => {
  const css = readFileSync(join(stylesDir, '../chat/styles/goal-investigation.css'), 'utf8');

  // 必须挂在「浮层可见」条件下，且作用于滚动容器。
  assert.match(
    css,
    /\.chat-surface:has\(\.goal-investigation:not\(\[data-hidden='true'\]\)\)\s*\.chat-thread\s*\{[^}]*padding-bottom:\s*\d+px/,
    'clearance must be conditioned on the floating layer being visible',
  );

  // 反向：不允许出现无条件的 .chat-thread 底部 padding —— 那正是死区的成因。
  assert.doesNotMatch(
    css,
    /^\s*\.chat-thread\s*\{[^}]*padding-bottom/m,
    'an unconditional clearance rule would reintroduce the dead gap',
  );
});

/**
 * 浮层确实是 absolute + 悬在锚点上方：这是「必须留净空」的前提。
 * 若将来把它改成占流（in-flow），净空规则应当一并删除——这条断言就是那个触发器。
 */
test('investigation layer stays off-layout (the premise of the clearance rule)', () => {
  const css = readFileSync(join(stylesDir, '../chat/styles/goal-investigation.css'), 'utf8');
  const body = ruleBody(css, '.goal-investigation');
  assert.match(body, /position:\s*absolute/, 'layer is expected to float above the composer');
  assert.match(
    body,
    /bottom:\s*calc\(100%\s*\+\s*\d+px\)/,
    'layer is expected to hang above its anchor by a fixed offset',
  );
});
