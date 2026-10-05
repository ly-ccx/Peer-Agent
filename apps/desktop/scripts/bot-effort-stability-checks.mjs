import assert from 'node:assert/strict';
import path from 'node:path';

/** Real component + delayed/failing production IPC save in the disposable smoke host. */
export async function checkEffortStability({ page, slider, strength, until, getBot, failNext, report, captureDirectory, highEffort, scope = 'settings' }) {
  const selector = scope === 'composer' ? '.bot-composer .reasoning-effort-trigger' : '.bot-model-settings-row .reasoning-effort-trigger';
  const sample = async key => {
    const baseline = await page.evaluate(selector => {
      const box = selector => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height }; };
      return { trigger: box(selector), panel: box('.reasoning-effort-panel') };
    }, selector);
    await slider.focus(); await slider.press(key);
    const frames = await page.evaluate(selector => new Promise(resolve => {
      const frames = [], start = performance.now();
      const capture = () => {
        const slider = document.querySelector('.reasoning-effort-slider');
        const trigger = document.querySelector(selector);
        const panel = document.querySelector('.reasoning-effort-panel');
        const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
        frames.push({ value: slider.value, trigger: rect(trigger), panel: rect(panel) });
        if (performance.now() - start < 420) requestAnimationFrame(capture); else resolve(frames);
      };
      requestAnimationFrame(capture);
    }), selector);
    const expected = key === 'End' ? '100' : '0';
    assert.ok(frames.length >= 5);
    assert.ok(frames.every(frame => frame.value === expected), 'selected effort must stay put throughout the delayed save');
    for (const frame of frames) for (const node of ['trigger', 'panel']) for (const axis of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(frame[node][axis] - baseline[node][axis]) < 0.5, `${node}.${axis} moved during save`);
    }
    return frames.length;
  };
  const successFrames = await sample('End');
  await page.keyboard.press('Escape');
  assert.equal(await strength.evaluate(node => node === document.activeElement), true, 'Escape must return focus even while the save is pending');
  await until(getBot, profile => profile.modelPolicy?.overrides?.project_agent?.reasoningEffort === highEffort);
  await until(() => strength.isEnabled(), Boolean); await strength.click();
  await until(() => slider.isEnabled(), Boolean);
  failNext();
  const failureFrames = await sample('Home');
  await page.getByText('模型设置未保存，请重试。', { exact: true }).first().waitFor();
  await until(() => slider.inputValue(), value => value === '100');
  assert.equal((await getBot()).modelPolicy.overrides.project_agent.reasoningEffort, highEffort);
  assert.equal(await strength.locator('.reasoning-effort-label').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'full effort label must fit the normal composer and settings width');
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, `effort-${scope}-save-rollback.png`) });
  (report.effortStability ??= {})[scope] = { delayMs: 650, successFrames, failureFrames, successHeld: true, failureHeldThenRolledBack: true,
    stableTriggerAndPanel: true, scope: 'Production settings slider and durable profile over actual IPC; controlled latency and failure' };
}
