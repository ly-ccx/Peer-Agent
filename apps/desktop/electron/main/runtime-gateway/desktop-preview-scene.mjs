// Fixed child-only scene implementation. Never accept model-provided JS, selectors
// or window identities. The caller is the owned preview entry, not the daily host.
export function normalizePreviewScene(scene) {
  if (scene === undefined) return 'application';
  if (scene === 'application' || scene === 'background-runtime') return scene;
  throw new Error('preview-scene-invalid');
}

function backgroundPanelState(open) {
  const visible = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const buttons = [...document.querySelectorAll('[data-testid="background-runtime-trigger"]')].filter(visible);
  if (buttons.length !== 1) return 'missing';
  const button = buttons[0];
  if (button.getAttribute('aria-expanded') !== 'true') {
    if (open && !button.disabled) { button.click(); return 'clicked'; }
    return 'opening';
  }
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  const state = panel?.querySelector('[data-testid="background-runtime-state"]');
  if (!visible(panel) || !visible(state)) return 'missing';
  return state.getAttribute('data-read-state') === 'ready' ? 'ready' : 'unready';
}

// Polling and two animation frames are bounded inside the owned renderer. We
// recheck after frames instead of claiming that a click alone proves readiness.
const openBackgroundPanel = `(${async function (check) {
  const started = Date.now();
  let mayOpen = true;
  while (Date.now() - started < 8000) {
    const state = check(mayOpen);
    if (state === 'clicked') mayOpen = false; // Wait for startup, but never click twice.
    if (state === 'ready') {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (check(false) === 'ready') return true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('preview-scene-not-ready');
}.toString()})(${backgroundPanelState.toString()})`;
const checkBackgroundPanel = `(${backgroundPanelState.toString()})(false) === 'ready'`;

export async function capturePreviewScene(webContents, requestedScene) {
  const scene = normalizePreviewScene(requestedScene);
  if (webContents.isDestroyed()) throw new Error('preview-scene-document');
  const url = webContents.getURL();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('preview-scene-document'); }
  if (parsed.protocol !== 'file:' || !parsed.pathname.endsWith('/index.html')) throw new Error('preview-scene-document');
  let navigated = false;
  const onNavigation = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) navigated = true; };
  const checkDocument = () => {
    if (navigated || webContents.isDestroyed() || webContents.getURL() !== url) throw new Error('preview-scene-document');
  };
  webContents.on('did-start-navigation', onNavigation);
  try {
    if (scene === 'background-runtime' && await webContents.executeJavaScript(openBackgroundPanel) !== true) {
      throw new Error('preview-scene-not-ready');
    }
    const check = async () => {
      checkDocument();
      if (scene === 'background-runtime' && await webContents.executeJavaScript(checkBackgroundPanel) !== true) {
        throw new Error('preview-scene-not-ready');
      }
      checkDocument(); // Also catch same-URL reloads during an awaited DOM check.
    };
    await check();
    const image = await webContents.capturePage();
    await check();
    return { scene, image };
  } finally { webContents.removeListener('did-start-navigation', onNavigation); }
}
