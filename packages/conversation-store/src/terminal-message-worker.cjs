const { parentPort, workerData } = require('node:worker_threads');
const { openSync, closeSync, fsyncSync, readFileSync, fstatSync, writeFileSync, unlinkSync } = require('node:fs');
const version = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const { historyFile, temporaryFile, messageId, patch } = workerData;
let fd;
try {
  fd = openSync(historyFile, 'r');
  const before = fstatSync(fd, { bigint: true });
  const text = readFileSync(fd, 'utf8');
  if (version(before) !== version(fstatSync(fd, { bigint: true }))) throw new Error('CONVERSATION_COMMIT_CONFLICT');
  const rows = text.split('\n').filter(line => line.trim()).map(line => {
    const row = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('CONVERSATION_HISTORY_CORRUPT');
    return row;
  });
  const index = rows.findIndex(row => row.id === messageId);
  if (index < 0) throw new Error('CONVERSATION_MESSAGE_MISSING');
  rows[index] = { ...rows[index], ...patch };
  const output = openSync(temporaryFile, 'wx', 0o600);
  try { writeFileSync(output, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); fsyncSync(output); }
  finally { closeSync(output); }
  parentPort.postMessage({ ok: true, sourceVersion: version(before), messageCount: rows.length });
} catch (error) {
  try { unlinkSync(temporaryFile); } catch {}
  parentPort.postMessage({ ok: false, code: error instanceof SyntaxError ? 'CONVERSATION_HISTORY_CORRUPT' : error.code || error.message, message: error.message });
} finally { if (fd !== undefined) closeSync(fd); }
