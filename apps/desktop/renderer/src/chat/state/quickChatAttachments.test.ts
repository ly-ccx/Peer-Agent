import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getClipboardFiles, hasQuickChatContent } from './quickChatAttachments.ts';

function clipboardItem(kind: string, file: File | null) {
  return { kind, getAsFile: () => file };
}

describe('Quick Chat attachments', () => {
  it('collects clipboard images and ignores text items', () => {
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    assert.deepEqual(getClipboardFiles([
      clipboardItem('string', null),
      clipboardItem('file', image),
      clipboardItem('file', null),
    ]), [image]);
  });

  it('allows attachment-only and text-plus-attachment sends', () => {
    const attachment = { id: 'a1', name: 'screenshot.png', mimeType: 'image/png', size: 5, kind: 'image' as const, dataUrl: 'data:image/png;base64,a' };
    assert.equal(hasQuickChatContent('', [attachment]), true);
    assert.equal(hasQuickChatContent('question', [attachment]), true);
    assert.equal(hasQuickChatContent('   ', []), false);
  });
});
