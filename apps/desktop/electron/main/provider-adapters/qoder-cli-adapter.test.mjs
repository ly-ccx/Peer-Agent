import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQoderCliArgs,
  buildQoderCliPrompt,
} from './qoder-cli-adapter.mjs';

describe('qoder CLI adapter', () => {
  it('builds a non-interactive qodercli interface invocation', () => {
    const args = buildQoderCliArgs({
      prompt: 'hello',
      model: 'Auto',
      contextWindow: 200000,
      maxOutputTokens: 4096,
    });

    assert.deepEqual(args, [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--model',
      'Auto',
      '--context-window',
      '200000',
      '--max-output-tokens',
      '4096',
      '--',
      'hello',
    ]);
  });

  it('renders conversation text without Qoder desktop forwarding language', () => {
    const prompt = buildQoderCliPrompt({
      systemPrompt: 'system',
      workspacePath: '/tmp/workspace',
      messages: [{ role: 'user', content: 'do work' }],
    });

    assert.match(prompt, /# Peer Agent conversation/);
    assert.match(prompt, /Workspace: \/tmp\/workspace/);
    assert.match(prompt, /## USER\n/);
    assert.match(prompt, /do work/);
    assert.doesNotMatch(prompt, /forwarded prompt|Continue the requested work in Qoder/i);
  });
});
