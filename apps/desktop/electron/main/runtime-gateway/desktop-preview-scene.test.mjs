import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { capturePreviewScene } from './desktop-preview-scene.mjs';

// Executes the actual fixed child script against a minimal DOM. This is not
// rendering evidence; the isolated Electron smoke covers the production DOM.
function fixture(options = {}) {
  let now = 0, clicks = 0, captures = 0, frames = 0, scripts = 0;
  let expanded = options.expanded ?? false;
  let state = options.state ?? 'ready';
  let url = options.url ?? 'file:///owned/renderer/index.html';
  let destroyed = false;
  const image = {};
  const element = attributes => ({
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    getAttribute: key => attributes[key],
  });
  const header = element({ 'data-read-state': state });
  header.getAttribute = key => key === 'data-read-state' ? state : null;
  const panel = element({});
  panel.querySelector = selector => {
    assert.equal(selector, '[data-testid="background-runtime-state"]');
    return options.missingState ? null : header;
  };
  const button = element({});
  button.disabled = options.disabled ?? false;
  button.getAttribute = key => ({ 'aria-expanded': String(expanded), 'aria-controls': 'background-panel' })[key];
  button.click = () => { clicks++; if (!options.delayed) expanded = true; };
  const wc = new EventEmitter();
  const sandbox = {
    Date: { now: () => now },
    setTimeout: resolve => { now += 1000; if (options.delayed && now >= 2000) expanded = true; resolve(); },
    requestAnimationFrame: resolve => { frames++; if (options.frameState) state = options.frameState; resolve(); },
    getComputedStyle: el => ({ display: options.hidden === el ? 'none' : 'block', visibility: 'visible' }),
    document: {
      querySelectorAll: selector => {
        assert.equal(selector, '[data-testid="background-runtime-trigger"]');
        return options.missing || (options.startup && now < 2000) ? [] : options.duplicate ? [button, button] : [button];
      },
      getElementById: id => { assert.equal(id, 'background-panel'); return options.missingPanel ? null : panel; },
    },
  };
  wc.getURL = () => url;
  wc.isDestroyed = () => destroyed;
  wc.executeJavaScript = async source => {
    scripts++;
    const result = await runInNewContext(source, sandbox);
    if (options.scriptNavigation && scripts === options.scriptNavigation) wc.emit('did-start-navigation', {}, url, false, true);
    return result;
  };
  wc.capturePage = async () => {
    captures++;
    if (options.captureState) state = options.captureState;
    if (options.navigate) url = 'file:///other/index.html';
    if (options.reload) wc.emit('did-start-navigation', {}, url, false, true);
    if (options.destroy) destroyed = true;
    return image;
  };
  return { wc, image, counts: () => ({ clicks, captures, frames, scripts }) };
}

for (const scene of ['application', 'background-runtime']) {
  test(`${scene} / ready: capture only the requested scene`, async () => {
    const f = fixture();
    assert.deepEqual(await capturePreviewScene(f.wc, scene), { scene, image: f.image });
    assert.equal(f.counts().clicks, scene === 'application' ? 0 : 1);
    assert.equal(f.counts().captures, 1);
    assert.equal(f.counts().frames, scene === 'application' ? 0 : 2);
    assert.equal(f.wc.listenerCount('did-start-navigation'), 0);
  });
  for (const scenario of ['navigate', 'reload', 'destroy']) {
    test(`${scene} / ${scenario} during capture: no successful image`, async () => {
      const f = fixture({ [scenario]: true });
      await assert.rejects(capturePreviewScene(f.wc, scene), /preview-scene-document/);
      assert.equal(f.wc.listenerCount('did-start-navigation'), 0);
    });
  }
}
for (const scenario of ['missing', 'duplicate', 'disabled', 'missingPanel', 'missingState']) {
  test(`background-runtime / ${scenario}: no fallback capture`, async () => {
    const f = fixture({ [scenario]: true });
    await assert.rejects(capturePreviewScene(f.wc, 'background-runtime'), /preview-scene-not-ready/);
    assert.equal(f.counts().captures, 0);
  });
}
for (const state of ['loading', 'error', 'stale']) {
  for (const phase of ['state', 'frameState', 'captureState']) {
    test(`background-runtime / ${phase}=${state}: reject unready scene`, async () => {
      const f = fixture({ [phase]: state });
      await assert.rejects(capturePreviewScene(f.wc, 'background-runtime'), /preview-scene-not-ready/);
      assert.equal(f.counts().captures, phase === 'captureState' ? 1 : 0);
    });
  }
}
test('background-runtime / startup mount delay: click once after the trigger appears', async () => {
  const f = fixture({ startup: true });
  await capturePreviewScene(f.wc, 'background-runtime');
  assert.equal(f.counts().clicks, 1);
});
test('background-runtime / delayed expansion: click only once', async () => {
  const f = fixture({ delayed: true });
  await capturePreviewScene(f.wc, 'background-runtime');
  assert.equal(f.counts().clicks, 1);
});
test('background-runtime / already open: never toggle the panel closed', async () => {
  const f = fixture({ expanded: true });
  await capturePreviewScene(f.wc, 'background-runtime');
  assert.equal(f.counts().clicks, 0);
});
for (const scriptNavigation of [1, 2, 3]) {
  test(`background-runtime / same-URL navigation at script ${scriptNavigation}: reject`, async () => {
    const f = fixture({ scriptNavigation });
    await assert.rejects(capturePreviewScene(f.wc, 'background-runtime'), /preview-scene-document/);
  });
}
for (const scene of [null, 'unknown', {}, 'background-runtime;alert(1)']) {
  test(`invalid scene ${JSON.stringify(scene)}: no script or capture`, async () => {
    const f = fixture();
    await assert.rejects(capturePreviewScene(f.wc, scene), /preview-scene-invalid/);
    assert.equal(f.counts().scripts + f.counts().captures, 0);
  });
}
test('omitted scene remains application', async () => {
  const f = fixture();
  assert.equal((await capturePreviewScene(f.wc)).scene, 'application');
  assert.equal(f.counts().scripts, 0);
});
for (const url of ['https://example.test/index.html', 'file:///owned/settings.html']) {
  test(`wrong document ${url}: no script or capture`, async () => {
    const f = fixture({ url });
    await assert.rejects(capturePreviewScene(f.wc, 'background-runtime'), /preview-scene-document/);
    assert.equal(f.counts().scripts + f.counts().captures, 0);
  });
}
