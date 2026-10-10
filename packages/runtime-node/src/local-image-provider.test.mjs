import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalImageProvider, isLocalImageObservation } from './local-image-provider.mjs';
import { checkpointWithoutLocalImagePixels, LOCAL_IMAGE_CONTEXT_PREFIX } from './local-image-checkpoint.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'image-provider-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'pixel.png'); await writeFile(path, PNG);
  const call = { toolCallId: 'image-1', capabilityId: 'local.image.read', arguments: { path } };
  const provider = createLocalImageProvider({ workspaceRoot: root, decodeImage: () => ({ width: 1, height: 1 }) });
  return { root, path, call, provider };
}
test('authorized image creates bound pixels and metadata-only Evidence', async t => {
  const { provider, call } = await fixture(t);
  const { result, grant } = await provider.executeCapability({ call });
  assert.equal(result.status, 'success'); assert.equal(grant.granted, true);
  const image = result.modelContext.visualObservations[0];
  assert.equal(image.dataUrl, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(isLocalImageObservation(image, call.toolCallId), true);
  assert.equal(isLocalImageObservation(image, 'another-call'), false);
  assert.equal(isLocalImageObservation({ ...image }, call.toolCallId), false);
  assert.doesNotMatch(JSON.stringify([grant, result.evidence, result.outputPreview]), /base64|iVBOR/);
  assert.doesNotMatch(JSON.stringify(result), /base64|iVBOR/);
  assert.equal(structuredClone(result).modelContext, undefined);
  assert.match(result.outputPreview.retrievalHint, /view_image/);
});
test('canonical symlinks require outside authorization, restricted Bot refuses', async t => {
  const f = await fixture(t); const outside = await fixture(t);
  const link = join(f.root, 'outside.png'); await symlink(outside.path, link);
  const call = { ...f.call, arguments: { path: link } };
  let asks = 0;
  const requestPermission = async request => {
    asks++; assert.equal(request.scope.path, outside.path);
    assert.equal(request.filePath, undefined); assert.equal(request.tool, undefined);
    assert.equal(request.capabilityId, 'local.image.read'); return { granted: true };
  };
  assert.equal((await f.provider.executeCapability({ call }, { requestPermission })).result.status, 'success');
  assert.equal(asks, 1);
  assert.equal((await f.provider.executeCapability({ call })).result.outputPreview.reason, 'image_permission_denied');
  assert.equal((await f.provider.executeCapability({ call }, { requestPermission, toolContext: { accessLevel: 'restricted_local' } })).result.outputPreview.reason, 'image_outside_read_scope');
  assert.equal(asks, 1);
});
test('no pixels on cancellation, denial, absence, malformed input or nonvision model', async t => {
  const f = await fixture(t); const ac = new AbortController(); ac.abort();
  const cases = [
    [{ signal: ac.signal }, f.call, 'image_read_cancelled'],
    [{ toolContext: { supportsVision: false } }, f.call, 'model_vision_unavailable'],
    [{ toolContext: { permissionPolicy: { kind: 'objective_probe' } } }, f.call, 'objective_probe_capability_denied'],
    [{}, { ...f.call, arguments: { path: join(f.root, 'missing') } }, 'image_not_found'],
    [{}, { ...f.call, arguments: {} }, 'image_path_required'],
    [{}, { ...f.call, arguments: { path: f.root } }, 'image_regular_file_required'],
  ];
  for (const [ctx, call, reason] of cases) {
    const { result } = await f.provider.executeCapability({ call }, ctx);
    assert.equal(result.outputPreview.reason, reason); assert.equal(result.modelContext, undefined);
  }
  await writeFile(f.path, '<svg></svg>');
  assert.equal((await f.provider.executeCapability({ call: f.call })).result.outputPreview.reason, 'image_type_unsupported');
  await writeFile(f.path, PNG.subarray(0, 10));
  assert.equal((await f.provider.executeCapability({ call: f.call })).result.outputPreview.reason, 'image_decode_failed');
});
test('limits prevent decoder allocation; missing/failed decoder is explicit', async t => {
  const f = await fixture(t); let decodes = 0;
  const decodeImage = () => { decodes++; return { width: 1, height: 1 }; };
  const small = createLocalImageProvider({ workspaceRoot: f.root, decodeImage, maxBytes: 8 });
  assert.equal((await small.executeCapability({ call: f.call })).result.outputPreview.reason, 'image_byte_limit_exceeded');
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(100_000, 16); bomb.writeUInt32BE(100_000, 20); await writeFile(f.path, bomb);
  const bounded = createLocalImageProvider({ workspaceRoot: f.root, decodeImage });
  assert.equal((await bounded.executeCapability({ call: f.call })).result.outputPreview.reason, 'image_pixel_limit_exceeded'); assert.equal(decodes, 0);
  await writeFile(f.path, PNG);
  assert.equal((await createLocalImageProvider({ workspaceRoot: f.root }).executeCapability({ call: f.call })).result.outputPreview.reason, 'image_decoder_unavailable');
  const broken = createLocalImageProvider({ workspaceRoot: f.root, decodeImage: () => ({ width: 0, height: 0 }) });
  assert.equal((await broken.executeCapability({ call: f.call })).result.outputPreview.reason, 'image_decode_failed');
});
test('file changed while authorization awaited is not observed', async t => {
  const f = await fixture(t); const other = await fixture(t);
  const execution = await f.provider.executeCapability({ call: { ...f.call, arguments: { path: other.path } } }, {
    requestPermission: async () => { await writeFile(other.path, Buffer.concat([PNG, Buffer.from('modified')])); return { granted: true }; },
  });
  assert.equal(execution.result.outputPreview.reason, 'image_changed_during_read');
  assert.equal(execution.result.modelContext, undefined);
});
test('durable checkpoints remove local pixels in all wires, preserve normal attachments and pairing', () => {
  const marker = { type: 'text', text: `${LOCAL_IMAGE_CONTEXT_PREFIX}{"path":"/tmp/a.png","sha256":"abc"}` };
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,LOCAL' } };
  const ordinary = { type: 'image_url', image_url: { url: 'data:image/png;base64,ATTACHMENT' } };
  const messages = [
    { role: 'tool', tool_call_id: 'call-1', content: '{}' },
    { role: 'user', content: [ordinary, marker, image] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: [marker, { type: 'image', source: { data: 'LOCAL' } }] }] },
    { role: 'user', geminiContent: { parts: [{ functionResponse: { name: 'view_image', response: {} } }, { text: marker.text }, { inlineData: { data: 'LOCAL' } }] } },
  ];
  const durable = checkpointWithoutLocalImagePixels(messages);
  const text = JSON.stringify(durable);
  assert.doesNotMatch(text, /LOCAL/); assert.match(text, /ATTACHMENT|Re-read/);
  assert.match(text, /call-1/); assert.match(text, /call-2/); assert.match(text, /sha256/);
  assert.equal(messages[1].content[2], image);
});
