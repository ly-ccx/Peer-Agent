/** Return the renderer that should receive Goal Runner chat stream events. */
export function getMainWindowWebContents(windows) {
  const mainWindow = windows.find(
    (window) => window.__peerAgentMainWindow === true && !window.isDestroyed(),
  );
  return mainWindow?.webContents ?? null;
}

/**
 * Route OAuth progress back to the renderer that initiated the IPC request.
 * If that renderer disappears while the browser flow is pending, fall back to
 * the tagged main window rather than an arbitrary utility window.
 */
export function getOAuthWindowWebContents(sender, windows) {
  if (sender && !sender.isDestroyed?.()) return sender;
  return getMainWindowWebContents(windows);
}
