/** Return the renderer that should receive Goal Runner chat stream events. */
export function getMainWindowWebContents(windows) {
  const mainWindow = windows.find(
    (window) => window.__peerAgentMainWindow === true && !window.isDestroyed(),
  );
  return mainWindow?.webContents ?? null;
}
