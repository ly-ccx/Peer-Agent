// Development-only reference: candidate runtime never spawns Bun/Node.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readJsonlByteWindow } from '../../packages/conversation-store/src/jsonl-byte-window.mjs';

const binary = resolve(process.argv[2]);
const fixture = JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/transcript-v1.json', import.meta.url), 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'peer-native-transcript-'));
writeFileSync(join(root, '.native-cli-fixture'), 'synthetic');
mkdirSync(join(root, 'conversations'));
const native = (conversation_id: string, cursor: unknown, records: number) => JSON.parse(execFileSync(binary, [], {
  input: JSON.stringify({ conversation_id, cursor, records }),
  env: { PATH: '/nonexistent', PEER_NATIVE_CONFORMANCE_ROOT: root }, encoding: 'utf8',
}));
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
let passed = 0;
for (const item of [
  ...fixture.cases,
  { name: 'cross-chunk-unicode', source: [ { id: 'old' }, { id: 'large', content: '测'.repeat(20_000) }, { id: 'new' } ].map(row=>JSON.stringify(row)).join('\n')+'\n', records: 2 },
  { name: 'large-prefix', source: Array.from({length:100_000},(_,id)=>JSON.stringify({id,content:'x'.repeat(64)})).join('\n')+'\n', records: 3, maxPages: 2 },
]) {
  const path = join(root, `conversations/${item.name}.jsonl`);
  writeFileSync(path, item.source);
  const before = digest(path);
  let cursor = null;
  for (let pageIndex=0; pageIndex<(item.maxPages ?? 20); pageIndex++) {
    const reference = readJsonlByteWindow(path, { limit:item.records, beforeByte:cursor?.beforeByte, chunkBytes:64 });
    const result = native(item.name, cursor, item.records);
    assert.equal(result.ok,true,item.name);
    const page = result.page;
    assert.equal(page.requiresRuntimeCheck,true);
    assert.deepEqual(page.rows.filter(row=>row.kind==='message').map(row=>row.raw),reference.messages,item.name);
    assert.equal(page.older?.beforeByte?.toString()??null,reference.cursor,item.name);
    if (item.name==='corrupt-line' && pageIndex===0) {
      const corrupt=page.rows.find(row=>row.kind==='invalid_json'); assert.ok(corrupt);
      assert.equal(Buffer.from(item.source).subarray(corrupt.range.start,corrupt.range.end).toString(),'{bad}');
    }
    if (item.name==='large-prefix') assert.ok(page.scannedBytes<=32*1024,'tail page must not scan the whole prefix');
    passed++;
    cursor = page.older;
    if (!cursor) break;
    assert.equal(cursor.conversationId,item.name);
    assert.equal(cursor.sourceRevision,page.sourceRevision);
  }
  assert.equal(digest(path),before,'native reads must preserve source bytes');
}
const path=join(root,'conversations/stale.jsonl'); writeFileSync(path,'{"id":"a"}\n{"id":"b"}\n');
const first=native('stale',null,1).page;
assert.equal(native('elsewhere',first.older,1).code,'NOT_FOUND');
assert.equal(native('stale',{...first.older,conversationId:'elsewhere'},1).code,'TRANSCRIPT_INVALID_CURSOR');passed++;
assert.equal(native('stale',{...first.older,beforeByte:1},1).code,'TRANSCRIPT_INVALID_CURSOR');passed++;
appendFileSync(path,'{"id":"c"}\n');
assert.equal(native('stale',first.older,1).code,'BACKGROUND_VERSION_CHANGED');passed++;
process.stdout.write(`${JSON.stringify({passed,fixtureRoot:root,coverage:'Real legacy JSONL window vs native raw display pages, Unicode/corruption/prefix cost/source preservation/stale cursor. No canonical history or execution.'})}\n`);
