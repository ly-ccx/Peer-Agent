import assert from 'node:assert/strict';
import path from 'node:path';

/** Real component + delayed/failing production IPC save in the disposable smoke host. */
export async function checkEffortStability({ page, slider, strength, until, getBot, failNext, report, captureDirectory, highEffort, scope = 'settings' }) {
  const selector = scope === 'composer' ? '.bot-composer .reasoning-effort-trigger' : '.bot-model-settings-row .reasoning-effort-trigger';
  const sample = async (key, collectionDelayMs = 0) => {
    const baseline = await page.evaluate(selector => {
      const box = selector => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height }; };
      return { trigger: box(selector), panel: box('.reasoning-effort-panel') };
    }, selector);
    await slider.focus();
    // Arm inside the renderer before dispatching the real key. A slow CDP round
    // trip must not start sampling after the controlled save has already failed.
    await page.evaluate(({ selector, key }) => {
      globalThis.rcEffortFrames = new Promise(resolve => {
        const frames = [];
        const slider = document.querySelector('.reasoning-effort-slider');
        let start = 0;
        const finish = () => { clearTimeout(deadline); slider.removeEventListener('keyup', begin); resolve(frames); };
        const capture = () => {
          if (performance.now() - start > 420) { finish(); return; }
          const slider = document.querySelector('.reasoning-effort-slider');
          const trigger = document.querySelector(selector);
          const panel = document.querySelector('.reasoning-effort-panel');
          const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
          frames.push({ value: slider.value, trigger: rect(trigger), panel: rect(panel) });
          requestAnimationFrame(capture);
        };
        const begin = event => {
          if (event.key !== key) return;
          slider.removeEventListener('keyup', begin);
          start = performance.now(); requestAnimationFrame(capture);
        };
        const deadline = setTimeout(finish, 15_000);
        slider.addEventListener('keyup', begin);
      });
    }, { selector, key });
    await slider.press(key);
    if (collectionDelayMs) await new Promise(resolve => setTimeout(resolve, collectionDelayMs));
    const frames = await page.evaluate(async () => {
      const frames = await globalThis.rcEffortFrames;
      delete globalThis.rcEffortFrames;
      return frames;
    });
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
  // Collect after the 650ms failure has returned. The renderer's earlier frames
  // must still prove the pending selection, independently of CDP delivery time.
  const failureFrames = await sample('Home', 900);
  await page.getByText('模型设置未保存，请重试。', { exact: true }).first().waitFor();
  await until(() => slider.inputValue(), value => value === '100');
  assert.equal((await getBot()).modelPolicy.overrides.project_agent.reasoningEffort, highEffort);
  assert.equal(await strength.locator('.reasoning-effort-label').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'full effort label must fit the normal composer and settings width');
  if (captureDirectory) await page.screenshot({ path: path.join(captureDirectory, `effort-${scope}-save-rollback.png`) });
  (report.effortStability ??= {})[scope] = { delayMs: 650, failureCollectionDelayMs: 900, successFrames, failureFrames, successHeld: true, failureHeldThenRolledBack: true,
    stableTriggerAndPanel: true, scope: 'Production settings slider and durable profile over actual IPC; controlled latency and failure' };
}
