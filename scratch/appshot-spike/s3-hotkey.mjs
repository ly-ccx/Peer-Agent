// S3: globalShortcut registration probe.
import { app, globalShortcut } from 'electron';
app.whenReady().then(() => {
  const report = {};
  report.standard = globalShortcut.register('CommandOrControl+Shift+A', () => {});
  let doubleCmdError = null;
  let doubleCmd = false;
  try { doubleCmd = globalShortcut.register('Command+Command', () => {}); }
  catch (e) { doubleCmdError = String(e.message); }
  let modifierOnlyError = null;
  let modifierOnly = false;
  try { modifierOnly = globalShortcut.register('Command', () => {}); }
  catch (e) { modifierOnlyError = String(e.message); }
  console.log(JSON.stringify({ report: { standard: report.standard, doubleCmd, doubleCmdError, modifierOnly, modifierOnlyError } }, null, 2));
  globalShortcut.unregisterAll();
  app.quit();
});
