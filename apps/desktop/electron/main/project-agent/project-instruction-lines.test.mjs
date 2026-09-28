import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { instructionLinesFromText, readProjectInstructionLines } from './project-instruction-lines.mjs';

test('项目说明按非空行交给准入，列表符号去掉', () => {
  assert.deepEqual(instructionLinesFromText('# 标题\n\n- 回复要短\n* 先看证据\n'), ['# 标题', '回复要短', '先看证据']);
});

test('读取项目目录里的 AGENTS.md', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-instructions-'));
  try {
    writeFileSync(path.join(dir, 'AGENTS.md'), '- 回复要短\n', 'utf8');
    assert.deepEqual(readProjectInstructionLines(dir), ['回复要短']);
    assert.deepEqual(readProjectInstructionLines(''), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
