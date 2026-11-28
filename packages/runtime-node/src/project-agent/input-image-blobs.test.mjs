import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInputQueue } from './input-queue.mjs';

test('large upload is deduplicated, survives queue restart, and only verified workspace blobs are readable', t => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-input-images-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const workspaceId = 'w', mimeType = 'image/png', bytes = Buffer.alloc(560 * 1024, 53);
  const blobDigest = createHash('sha256').update(bytes).digest('hex');
  const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  const upload = { id: 'paste', name: 'paste.png', kind: 'image', sourceKind: 'user_upload', size: bytes.length, mimeType };
  const submit = { workspaceId, surface: 'desktop', text: '', inputId: 'paste' };
  const queue = createInputQueue({ rootDir });
  assert.throws(() => queue.submitInput({ ...submit, attachments: [{ ...upload, blobDigest }] }), /image data is invalid/);
  const saved = queue.submitInput({ ...submit, attachments: [{ ...upload, dataUrl, blobDigest: 'a'.repeat(64) }] });
  assert.equal(saved.attachments[0].blobDigest, blobDigest);
  queue.submitInput({ ...submit, inputId: 'again', attachments: [{ ...upload, dataUrl }] });
  const directory = path.join(rootDir, workspaceId, 'attachment-blobs');
  const filename = `${blobDigest}.png`, file = path.join(directory, filename);
  assert.deepEqual(readdirSync(directory), [filename]);
  assert.deepEqual(readFileSync(file), bytes);
  // Native Rust writes this format, without inline data and with a legacy absolute path.
  appendFileSync(path.join(rootDir, workspaceId, 'input-queue.jsonl'), JSON.stringify({ ...submit, inputId: 'native',
    createdAt: saved.createdAt, attachments: [{ ...upload, blobDigest, filePath: '/not-trusted' }] }) + '\n');
  const messages = [];
  const restarted = createInputQueue({ rootDir, resolveConversationId: () => 'conv', hasMessage: () => false,
    appendMessage: (_, message) => messages.push(message) });
  assert.deepEqual(restarted.findSubmission(workspaceId, 'paste'), saved);
  assert.equal(restarted.consume(workspaceId).consumed.length, 3);
  assert.equal(messages[0].attachments[0].blobDigest, blobDigest);
  assert.deepEqual(messages[2].attachments[0], { ...upload, blobDigest });
  assert.equal(restarted.readImage(workspaceId, blobDigest, mimeType), dataUrl);
  assert.equal(restarted.readImage('another', blobDigest, mimeType), null);
  assert.equal(restarted.readImage('../w', blobDigest, mimeType), null);
  assert.equal(restarted.readImage(workspaceId, '../paste.png', mimeType), null);
  assert.equal(restarted.readImage(workspaceId, blobDigest, 'image/jpeg'), null);
  writeFileSync(file, Buffer.from('changed'));
  assert.equal(restarted.readImage(workspaceId, blobDigest, mimeType), null);
  rmSync(file);
  assert.equal(restarted.readImage(workspaceId, blobDigest, mimeType), null);
  if (process.platform !== 'win32') {
    const external = path.join(rootDir, 'external');
    mkdirSync(external);
    writeFileSync(path.join(external, filename), bytes);
    symlinkSync(path.join(external, filename), file);
    assert.equal(restarted.readImage(workspaceId, blobDigest, mimeType), null);
    rmSync(directory, { recursive: true });
    symlinkSync(external, directory);
    assert.equal(restarted.readImage(workspaceId, blobDigest, mimeType), null);
  }
});
