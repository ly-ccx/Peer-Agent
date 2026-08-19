import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTextLikeFile,
  TEXT_LIKE_EXTENSIONS,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_FILE_BYTES,
  intakeAttachments,
} from './attachmentIntake.ts';

// 轻量 stub：isTextLikeFile 只读取 file.type 与 file.name，无需真实 File/FileReader。
function fakeFile(name: string, type = ''): File {
  return { name, type } as unknown as File;
}

describe('attachmentIntake constants', () => {
  it('keeps the original limits', () => {
    assert.equal(MAX_ATTACHMENTS, 8);
    assert.equal(MAX_IMAGE_BYTES, 8 * 1024 * 1024);
    assert.equal(MAX_TEXT_FILE_BYTES, 512 * 1024);
  });
});

describe('isTextLikeFile', () => {
  it('returns true when MIME starts with text/', () => {
    assert.equal(isTextLikeFile(fakeFile('whatever.bin', 'text/plain')), true);
  });
  it('returns true for whitelisted extensions regardless of MIME', () => {
    for (const ext of TEXT_LIKE_EXTENSIONS) {
      assert.equal(isTextLikeFile(fakeFile(`file${ext}`, '')), true, `expected ${ext} to be text-like`);
    }
  });
  it('is case-insensitive on the extension', () => {
    assert.equal(isTextLikeFile(fakeFile('README.MD', '')), true);
    assert.equal(isTextLikeFile(fakeFile('Main.TS', '')), true);
  });
  it('returns false for non-text binary files', () => {
    assert.equal(isTextLikeFile(fakeFile('photo.png', 'image/png')), false);
    assert.equal(isTextLikeFile(fakeFile('archive.zip', 'application/zip')), false);
    assert.equal(isTextLikeFile(fakeFile('noext', '')), false);
  });
});

describe('intakeAttachments', () => {
  it('enforces the shared per-message attachment limit before reading files', async () => {
    const result = await intakeAttachments([fakeFile('extra.txt', 'text/plain')], MAX_ATTACHMENTS, true);
    assert.deepEqual(result.attachments, []);
    assert.equal(result.error, `最多只能添加 ${MAX_ATTACHMENTS} 个附件`);
  });

  it('preserves unsupported files as metadata-only attachments', async () => {
    const file = { name: 'archive.zip', type: 'application/zip', size: 42 } as File;
    const result = await intakeAttachments([file], 0, false, () => 'attachment-id');
    assert.deepEqual(result.attachments, [{
      id: 'attachment-id',
      name: 'archive.zip',
      mimeType: 'application/zip',
      size: 42,
      kind: 'unsupported',
      sourceKind: 'user_upload',
    }]);
    assert.equal(result.error, null);
  });
});
