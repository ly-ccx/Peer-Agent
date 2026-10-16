import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalImageProvider } from './local-image-provider.mjs';
import { LOCAL_IMAGE_CONTEXT_PREFIX, bindLocalImageContextBlock, createLocalImageContinuationStore } from './local-image-checkpoint.mjs';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const scope = { conversationId: 'bot', workspacePath: '/project', planId: 'plan', provider: 'openai', providerId: 'custom', model: 'vision' };
async function observation(t) {
 const root = await mkdtemp(join(tmpdir(), 'local-continuation-')); t.after(() => rm(root, { recursive: true, force: true }));
 const path = join(root, 'outside.png'); await writeFile(path, PNG); let allowed = true;
 const provider = createLocalImageProvider({ workspaceRoot: '/different-project', decodeImage: () => ({ width: 1, height: 1 }) });
 const execution = await provider.executeCapability({ call: { toolCallId: 'actual-read', capabilityId: 'local.image.read', arguments: { path } } }, { requestPermission: async () => ({ granted: true, validate: () => allowed }) });
 assert.equal(execution.result.status, 'success');
 return { image: execution.result.modelContext.visualObservations[0], revoke: () => { allowed = false; } };
}
function messages(image, wire = 'openai') {
 const marker = { type: 'text', text: `${LOCAL_IMAGE_CONTEXT_PREFIX}${JSON.stringify({ path: image.path, sha256: image.sha256 })}` };
 const block = wire === 'openai' ? { type: 'image_url', image_url: { url: image.dataUrl } }
  : wire === 'anthropic' ? { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: PNG.toString('base64') } }
   : { inlineData: { mimeType: image.mediaType, data: PNG.toString('base64') } };
 bindLocalImageContextBlock(block, image);
 return wire === 'gemini' ? [{ role: 'user', geminiContent: { parts: [{ text: marker.text }, block] } }]
  : wire === 'anthropic' ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'actual-read', content: [marker, block] }] }]
   : [{ role: 'tool', tool_call_id: 'actual-read', content: '{}' }, { role: 'user', content: [marker, block] }];
}
test('all provider wires keep genuine authorized pixels across voluntary slices without persisting them', async t => {
 const { image } = await observation(t);
 for (const wire of ['openai', 'anthropic', 'gemini']) {
  const store = createLocalImageContinuationStore(); const source = messages(image, wire);
  const checkpoint = store.checkpoint({ messages: source }, scope);
  assert.doesNotMatch(JSON.stringify(checkpoint), /base64|iVBOR/);
  const restored = store.restore(JSON.parse(JSON.stringify(checkpoint)), scope);
  assert.match(JSON.stringify(restored), /iVBOR/);
  // Restored blocks retain host provenance for another fair scheduling slice.
  assert.match(JSON.stringify(store.restore(store.checkpoint({ messages: restored }, scope), scope)), /iVBOR/);
  assert.doesNotMatch(JSON.stringify(store.restore(checkpoint, scope)), /iVBOR/, 'locator is single-use');
 }
});
test('forged observation, altered messages, wrong identity and fresh host cannot restore pixels', async t => {
 const { image } = await observation(t);
 const store = createLocalImageContinuationStore();
 assert.equal(store.checkpoint({ messages: messages({ ...image }) }, scope).transientLocalImageContextId, undefined);
 const checkpoint = store.checkpoint({ messages: messages(image) }, scope);
 const mutable = messages(image); const mutableCheckpoint = store.checkpoint({ messages: mutable }, scope);
 mutable[1].content[1].image_url.url = 'data:image/png;base64,FORGED';
 assert.doesNotMatch(JSON.stringify(store.restore(mutableCheckpoint, scope)), /FORGED|iVBOR/);
 for (const key of ['conversationId', 'workspacePath', 'planId', 'provider', 'providerId', 'model']) {
  assert.doesNotMatch(JSON.stringify(store.restore(checkpoint, { ...scope, [key]: 'different' })), /iVBOR/);
 }
 assert.doesNotMatch(JSON.stringify(createLocalImageContinuationStore().restore(checkpoint, scope)), /iVBOR/);
 const altered = structuredClone(checkpoint); altered.messages[0].content = 'changed Tool Result';
 assert.doesNotMatch(JSON.stringify(store.restore(altered, scope)), /iVBOR/);
});
test('revoked, expired or evicted continuations leave metadata and retrieval hints only', async t => {
 const { image, revoke } = await observation(t); let now = 0;
 const store = createLocalImageContinuationStore({ now: () => now, ttlMs: 5, maxEntries: 1 });
 let checkpoint = store.checkpoint({ messages: messages(image) }, scope);
 store.checkpoint({ messages: messages(image) }, scope);
 assert.doesNotMatch(JSON.stringify(store.restore(checkpoint, scope)), /iVBOR/);
 checkpoint = store.checkpoint({ messages: messages(image) }, scope); now = 5;
 assert.doesNotMatch(JSON.stringify(store.restore(checkpoint, scope)), /iVBOR/);
 assert.equal(createLocalImageContinuationStore({ maxBytes: 1 }).checkpoint({ messages: messages(image) }, scope).transientLocalImageContextId, undefined);
 checkpoint = store.checkpoint({ messages: messages(image) }, scope); revoke();
 const restored = store.restore(checkpoint, scope);
 assert.doesNotMatch(JSON.stringify(restored), /iVBOR/); assert.match(JSON.stringify(restored), /Re-read/);
});
