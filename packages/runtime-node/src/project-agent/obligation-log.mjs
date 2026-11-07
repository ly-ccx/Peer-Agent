import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 256 * 1024;
const KEEP = 3;

/** Fixed local log. PEER_AGENT_HOME keeps rehearsal off the real home. */
export function obligationLogPath(env = process.env, home = os.homedir()) {
  const root = typeof env.PEER_AGENT_HOME === 'string' && env.PEER_AGENT_HOME.trim()
    ? env.PEER_AGENT_HOME.trim()
    : path.join(home, '.peer-agent');
  return path.join(root, 'logs', 'obligation.log');
}

export function rotateLogFile(file, keep = KEEP) {
  try { unlinkSync(`${file}.${keep}`); } catch (error) { if (error?.code !== 'ENOENT') return; }
  for (let index = keep - 1; index >= 1; index -= 1) {
    try { renameSync(`${file}.${index}`, `${file}.${index + 1}`); }
    catch (error) { if (error?.code !== 'ENOENT') return; }
  }
  try { renameSync(file, `${file}.1`); }
  catch (error) { if (error?.code !== 'ENOENT') return; }
}

export function createRotatingLineLog({ file, maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  return function write(line) {
    const safe = String(line).replace(/[\r\n]/g, ' ').slice(0, 2000);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = statSync(file).size; }
      catch (error) { if (error?.code !== 'ENOENT') return; }
      if (size > 0 && size + safe.length + 1 > maxBytes) rotateLogFile(file, keep);
      appendFileSync(file, `${safe}\n`, 'utf8');
    } catch {
      // A log must not change tool, cancel, or timer behavior.
    }
  };
}

function compact(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.slice(0, 40).map(item => item.slice(0, 80));
  return undefined;
}

/** Names, ids, and refusal codes only. Tool arguments and file contents stay out. */
export function appendObligationLog(record, env = process.env) {
  const body = { at: new Date().toISOString() };
  for (const [key, value] of Object.entries(record || {})) {
    const safe = compact(value);
    if (safe !== undefined) body[key] = safe;
  }
  createRotatingLineLog({ file: obligationLogPath(env) })(JSON.stringify(body));
}
