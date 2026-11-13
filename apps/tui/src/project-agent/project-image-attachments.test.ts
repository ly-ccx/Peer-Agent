import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadProjectImageAttachments,mergeProjectAttachments,dataUrlByteLength,PROJECT_INPUT_ATTACHMENT_LIMIT} from './project-image-attachments.ts';

// A real 1x1 PNG; byte length must survive the round trip through the data URL.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-project-image-'));
  return {root, done(){ rmSync(root,{recursive:true,force:true}); }};
}

test('a pasted image path becomes a real user_upload attachment', async () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, 'image-1794530499921.png');
    writeFileSync(file, PNG);
    const result = await loadProjectImageAttachments(`${file} 为什么样式不一样`);
    expect(result.attachments.length).toBe(1);
    const [image] = result.attachments;
    // The durable boundary validates each of these, so assert the exact contract.
    expect(image!.sourceKind).toBe('user_upload');
    expect(image!.kind).toBe('image');
    expect(image!.mimeType).toBe('image/png');
    expect(image!.name).toBe('image-1794530499921.png');
    expect(image!.size).toBe(PNG.byteLength);
    expect(image!.size).toBe(dataUrlByteLength(image!.dataUrl));
    expect(image!.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    // The path must not leak into the message body alongside the attachment.
    expect(result.text).toBe('为什么样式不一样');
    expect(result.missingPaths).toEqual([]);
  } finally { box.done(); }
});

test('text alone produces no attachments and keeps the wording intact', async () => {
  const box = sandbox();
  try {
    const result = await loadProjectImageAttachments('普通的一句话，没有图片');
    expect(result.attachments).toEqual([]);
    expect(result.text).toBe('普通的一句话，没有图片');
  } finally { box.done(); }
});

test('a missing image file is reported instead of becoming a broken upload', async () => {
  const box = sandbox();
  try {
    const missing = path.join(box.root, 'not-there.png');
    const result = await loadProjectImageAttachments(missing);
    expect(result.attachments).toEqual([]);
    expect(result.missingPaths.length).toBe(1);
  } finally { box.done(); }
});

test('re-pasting the same image replaces the row instead of duplicating it', async () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, 'same.png');
    writeFileSync(file, PNG);
    const first = await loadProjectImageAttachments(file);
    const second = await loadProjectImageAttachments(file);
    const merged = mergeProjectAttachments(first.attachments, second.attachments);
    expect(merged.length).toBe(1);
    expect(merged[0]!.id).toBe(first.attachments[0]!.id);
  } finally { box.done(); }
});

test('merged attachments stay within the durable upload limit', async () => {
  const box = sandbox();
  try {
    const files: string[] = [];
    for (let index = 0; index < PROJECT_INPUT_ATTACHMENT_LIMIT + 3; index += 1) {
      // Distinct bytes per file so each payload hashes to a distinct id.
      const file = path.join(box.root, `image-${index}.png`);
      writeFileSync(file, Buffer.concat([PNG, Buffer.from(`#${index}`)]));
      files.push(file);
    }
    const loaded = await loadProjectImageAttachments(files.join(' '));
    expect(loaded.attachments.length).toBe(PROJECT_INPUT_ATTACHMENT_LIMIT);
    let accumulated = mergeProjectAttachments([], loaded.attachments);
    for (const file of files) {
      const one = await loadProjectImageAttachments(file);
      accumulated = mergeProjectAttachments(accumulated, one.attachments);
    }
    expect(accumulated.length).toBe(PROJECT_INPUT_ATTACHMENT_LIMIT);
  } finally { box.done(); }
});

test('data URL byte length counts decoded bytes, not base64 characters', () => {
  expect(dataUrlByteLength(`data:image/png;base64,${PNG.toString('base64')}`)).toBe(PNG.byteLength);
  expect(dataUrlByteLength('data:image/png;base64,')).toBe(0);
});

test('a chipped composer value still resolves to the real image on send', async () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, 'image-1794530499921.png');
    writeFileSync(file, PNG);
    const {chipifyImagePathsInText,extractImagePathTokens,registerImagePathKeys} = await import('../composer-image-paths.ts');
    // Mirrors the composer: the user pastes a raw path, which is chipped for display.
    const raw = `${file} 为什么样式不一样`;
    const registry = new Map<string,string>();
    registerImagePathKeys(registry, extractImagePathTokens(raw));
    const chipped = chipifyImagePathsInText(raw);
    expect(chipped).toContain('[Image ');
    // A chip keeps no raw path token, so submit's detection must also accept the label form.
    expect(extractImagePathTokens(chipped).length).toBe(0);
    const result = await loadProjectImageAttachments(chipped, {pathByKey: registry});
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0]!.size).toBe(PNG.byteLength);
    expect(result.text).toBe('为什么样式不一样');
  } finally { box.done(); }
});
