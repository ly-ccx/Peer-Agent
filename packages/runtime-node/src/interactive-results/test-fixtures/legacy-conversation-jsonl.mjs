// Pinned 8b3ffbcf01a9b9a14ac6969a9e67a1918876b528:packages/conversation-store/src/index.mjs
// Exact readJsonl→readJson block SHA-256: f943550e04e210417ac7615ceb2facfcbe46757d58b6fe4b5743e8dd70cb65c0
// Only imports and exports added. These are the old JSONL primitives, not a
// complete old ConversationStore or a claim about live old-host concurrency.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function writeJsonl(filePath, rows) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function appendJsonl(filePath, row) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}


export { readJsonl, writeJsonl, appendJsonl };
