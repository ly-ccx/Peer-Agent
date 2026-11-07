import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncDirectory, syncFile } from './fsync-path.mjs';

test('durable fsync opens files and directories with a flushable handle on every platform', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-fsync-path-'));
  try {
    const file = path.join(root, 'record.jsonl');
    writeFileSync(file, '{}\n');
    syncFile(file);
    const segments = path.join(root, 'segments');
    mkdirSync(segments);
    syncDirectory(segments);
    syncDirectory(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
