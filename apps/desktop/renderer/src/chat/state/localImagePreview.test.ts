import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLocalImagePath } from './localImagePath.ts';

describe('isLocalImagePath', () => {
  it('accepts common image extensions', () => {
    assert.equal(isLocalImagePath('/tmp/peer-header-shots/definition-header.png'), true);
    assert.equal(isLocalImagePath('/Users/me/a.JPG'), true);
    assert.equal(isLocalImagePath('shots/run-header.webp'), true);
  });

  it('rejects non-image paths and urls', () => {
    assert.equal(isLocalImagePath('/tmp/notes.txt'), false);
    assert.equal(isLocalImagePath('https://example.com/a.png'), false);
    assert.equal(isLocalImagePath('useState'), false);
    assert.equal(isLocalImagePath(''), false);
  });
});
