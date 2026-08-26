import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = () => readFile(new URL('./gitGlyphs.tsx', import.meta.url), 'utf8');

test('GitWorktreeGlyph uses a single canopy path instead of overlapping arcs', async () => {
  const source = await readSource();

  assert.match(source, /export function GitWorktreeGlyph\(\)/);
  assert.match(source, /<path d="M7 16 12 5l5 11Z" \/>/);
  assert.match(source, /<path d="M12 22V16" \/>/);
  assert.doesNotMatch(source, /c-2\.2-1\.4-3\.5-3\.4/);
  assert.doesNotMatch(source, /c-3\.2-1\.6-5\.2-3\.8/);
});

test('GitWorktreeGlyph shares the 12px stroke language with GitBranchGlyph', async () => {
  const source = await readSource();
  const branch = source.match(/export function GitBranchGlyph\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const worktree = source.match(/export function GitWorktreeGlyph\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(branch, /width="12" height="12" viewBox="0 0 24 24"/);
  assert.match(worktree, /width="12" height="12" viewBox="0 0 24 24"/);
  assert.match(branch, /strokeWidth="2"/);
  assert.match(worktree, /strokeWidth="2"/);
  assert.match(branch, /strokeLinecap="round" strokeLinejoin="round"/);
  assert.match(worktree, /strokeLinecap="round" strokeLinejoin="round"/);
});
