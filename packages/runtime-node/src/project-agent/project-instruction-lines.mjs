/**
 * 把项目说明拆成准入可比对的行。冲突判断是整行相等，不解释正文。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FILES = ['AGENTS.md', 'CLAUDE.md'];
const FILE_CHARS = 24_000;
const LINE_MAX = 400;

export function instructionLinesFromText(text) {
  const lines = [];
  const source = typeof text === 'string' ? text : '';
  for (const raw of source.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '').trim();
    if (!line) continue;
    lines.push(line.length > 2000 ? line.slice(0, 2000) : line);
    if (lines.length >= LINE_MAX) break;
  }
  return lines;
}

export function readProjectInstructionLines(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return [];
  const lines = [];
  for (const name of FILES) {
    const file = path.join(folder, name);
    if (!existsSync(file)) continue;
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    lines.push(...instructionLinesFromText(raw.slice(0, FILE_CHARS)));
    if (lines.length >= LINE_MAX) break;
  }
  return lines.slice(0, LINE_MAX);
}
