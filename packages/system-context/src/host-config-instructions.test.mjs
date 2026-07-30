import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildHostConfigInstructions,
  resolveGitBranchPrefix,
} from './index.mjs';

describe('host config instructions', () => {
  it('materializes one canonical instruction set for every host', () => {
    const instructions = buildHostConfigInstructions({
      systemInstructions: '  Keep answers concise.  ',
      replyLanguage: 'ja-JP',
      gitBranchPrefix: '  team/  ',
    });

    assert.deepEqual(instructions.map((item) => item.id), [
      'settings.systemInstructions',
      'settings.replyLanguage',
      'settings.gitBranchPrefix',
    ]);
    assert.equal(instructions[0].content, 'Keep answers concise.');
    assert.match(instructions[1].content, /Japanese \(日本語\)/);
    assert.match(instructions[2].content, /prefix "team\/"/);
  });

  it('omits empty optional instructions and keeps the governed branch default', () => {
    const instructions = buildHostConfigInstructions({
      systemInstructions: ' ',
      replyLanguage: 'auto',
      gitBranchPrefix: null,
    });

    assert.deepEqual(instructions.map((item) => item.id), [
      'settings.gitBranchPrefix',
    ]);
    assert.equal(resolveGitBranchPrefix(null), 'PeerAgent/');
    assert.match(instructions[0].content, /prefix "PeerAgent\/"/);
  });
});
