import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync, rmSync } from 'node:fs';

/** The renderer chooses an action; only the native dialog supplies a destination. */
export function createDiagnosticsExport({ readReport, chooseTarget, write = writeFileSync, rename = renameSync, remove = rmSync } = {}) {
  async function execute(payload, sender) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'action')
      || !['read','export'].includes(payload.action)) return { ok: false, code: 'INVALID_INPUT' };
    let report;
    try { report = readReport(); } catch { return { ok: false, code: 'DIAGNOSTICS_UNAVAILABLE' }; }
    if (payload.action === 'read') return { ok: true, report };
    let temp;
    try {
      const target = await chooseTarget(sender);
      if (target?.canceled) return { ok: true, report, saved: false, cancelled: true };
      if (typeof target?.filePath !== 'string' || !target.filePath) throw new Error('invalid_target');
      const body = `${JSON.stringify(report, null, 2)}\n`;
      temp = `${target.filePath}.${randomUUID()}.tmp`;
      write(temp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      rename(temp, target.filePath);
      return { ok: true, report, saved: true };
    } catch {
      if (temp) { try { remove(temp, { force: true }); } catch { /* Original destination is preserved. */ } }
      return { ok: false, code: 'DIAGNOSTICS_SAVE_FAILED' };
    }
  }
  return { execute };
}
