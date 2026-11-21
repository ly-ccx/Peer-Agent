// Development oracle only; the Rust executable never launches this script.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNodeFileProvider } from '../../packages/runtime-node/dist/file-provider.js';
import { encodeProviderToolResult } from '../../packages/runtime-node/dist/tool-result-encoder.js';
const root = mkdtempSync(join(tmpdir(), 'peer-tool-artifact-oracle-'));
writeFileSync(join(root, '.native-cli-fixture'), 'isolated');
const workspace = join(root, 'workspace'); mkdirSync(workspace);
const provider = createNodeFileProvider({ workspaceRoot: workspace, requestApproval: () => ({ granted: true, reason: 'synthetic' }) });
const execute = async (capabilityId, input) => provider.execute({ capabilityId, input, toolCall: { toolCallId: 'synthetic', capabilityId, input } }, { runId: 'run', sessionId: 'session', workspace: { root: workspace } });
const text = 'original🦀 fact\n'.repeat(10000);
writeFileSync(join(workspace, 'input.txt'), text);
const read = await execute('local.file.read', { path: 'input.txt' });
assert.equal(read.status, 'completed'); assert.equal(read.output.content, text);
assert.equal(read.output.bytes, Buffer.byteLength(text));
assert.equal(read.output.contentHash, createHash('sha256').update(text).digest('hex'));
const writeText = 'w'.repeat(90 * 1024);
const write = await execute('local.file.write', { path: 'large.txt', content: writeText });
assert.equal(write.status, 'completed');
for (const kind of ['local_file_ref', 'local_tool_result_ref']) {
  const reference = { schemaVersion: 1, conversationId: 'c', sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), format: 'utf8' };
  const output = { kind, preview: 'bounded original observation 🦀', truncated: true, nativeContentRef: reference, retrieval: { tool: 'read_tool_result', arguments: { reference, offset: 0, length: 4096 } } };
  const encoded = encodeProviderToolResult({ result: { status: 'success', output }, conversationId: 'c', toolCallId: 'synthetic', baseDir: join(root, 'cache') });
  assert.equal(encoded.materialized, false);
  assert.deepEqual(JSON.parse(encoded.content), output, 'existing-ref encoder preserves the immutable native reference');
}
console.log(JSON.stringify({ ok: true, root, cases: 4, readBytes: Buffer.byteLength(text), writeBytes: writeText.length, scope: 'Actual TS File Provider and existing-ref model encoder; native storage/authorization/recovery are separately tested, not claimed as legacy LRU parity.' }));
