import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateAttachmentTokens,
  estimateDraftTokens,
  estimateTextTokens,
} from './tokenEstimate.ts';
import type { ChatAttachment } from './types.ts';

describe('composer draft token preview', () => {
  it('uses a denser estimate for CJK text', () => {
    assert.ok(estimateTextTokens('你好世界') > estimateTextTokens('abcd'));
  });

  it('includes draft attachments without reading conversation history', () => {
    const attachments: ChatAttachment[] = [{
      id: 'image-1',
      kind: 'image',
      name: 'screen.png',
      mimeType: 'image/png',
      size: 42,
    }];
    assert.equal(
      estimateDraftTokens('hello', attachments),
      estimateTextTokens('hello') + estimateAttachmentTokens(attachments),
    );
    assert.ok(estimateAttachmentTokens(attachments) >= 800);
  });
});
