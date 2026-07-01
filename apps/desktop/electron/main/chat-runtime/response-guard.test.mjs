import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasLiteralToolCallSyntax,
  shouldRetryNoToolResponse,
} from './response-guard.mjs';

describe('hasLiteralToolCallSyntax', () => {
  it('detects a tool call leaked into the text channel', () => {
    const text = 'call\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>';
    assert.equal(hasLiteralToolCallSyntax(text), true);
  });

  it('detects function_calls and antml: variants', () => {
    assert.equal(hasLiteralToolCallSyntax('<function_calls>'), true);
    assert.equal(hasLiteralToolCallSyntax('<invoke name="x">'), true);
  });

  it('detects OpenAI-compatible pseudo function tags leaked as text', () => {
    const text = '<functions.bash agext={{"command":"cd /tmp && git diff"}} />';
    assert.equal(hasLiteralToolCallSyntax(text), true);
    assert.equal(shouldRetryNoToolResponse(text), true);
  });

  it('does not fire on neutralized (&lt;) content', () => {
    assert.equal(hasLiteralToolCallSyntax('already &lt;invoke escaped'), false);
  });

  it('does not fire on normal prose or unrelated tags', () => {
    assert.equal(hasLiteralToolCallSyntax('a normal answer with <div> markup'), false);
    assert.equal(hasLiteralToolCallSyntax('no angle brackets here'), false);
  });
});

describe('shouldRetryNoToolResponse with literal tool-call syntax', () => {
  it('triggers retry instead of terminating when a tool call is printed as text', () => {
    const text = '<invoke name="goal_update_task"><parameter name="planId">x</parameter></invoke>';
    assert.equal(shouldRetryNoToolResponse(text), true);
  });

  it('still returns false for a clean normal answer', () => {
    assert.equal(shouldRetryNoToolResponse('Here is the explanation you asked for.'), false);
  });
});
