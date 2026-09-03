import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasEmptyWriteNarration,
  hasIncompleteActionNarration,
  hasLiteralToolCallSyntax,
  hasUnsupportedToolClaim,
  shouldRetryNoToolResponse,
  unsupportedToolResponseCorrection,
} from './response-guard.mjs';

describe('hasLiteralToolCallSyntax', () => {
  it('detects a tool call leaked into the text channel', () => {
    const text = 'call\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n</invoke>';
    assert.equal(hasLiteralToolCallSyntax(text), true);
  });

  it('detects function_calls and antml: variants', () => {
    assert.equal(hasLiteralToolCallSyntax('<tool_call>{"name":"bash"}</tool_call>'), true);
    assert.equal(hasLiteralToolCallSyntax('<function_calls>'), true);
    assert.equal(hasLiteralToolCallSyntax('<invoke name="x">'), true);
  });

  it('detects OpenAI-compatible pseudo function tags leaked as text', () => {
    const text = '<functions.bash agext={{"command":"cd /tmp && git diff"}} />';
    assert.equal(hasLiteralToolCallSyntax(text), true);
    assert.equal(shouldRetryNoToolResponse(text), true);
  });

  it('detects HTML-escaped tool protocol leaked as text', () => {
    assert.equal(hasLiteralToolCallSyntax('&lt;tool_call&gt;{"name":"bash"}&lt;/tool_call&gt;'), true);
    assert.equal(hasLiteralToolCallSyntax('already &lt;invoke escaped'), true);
    assert.equal(shouldRetryNoToolResponse('&lt;tool_call&gt;{"name":"bash"}&lt;/tool_call&gt;'), true);
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

  it('retries file-read preambles that never emitted a tool call', () => {
    const text = [
      'Let me continue with the goal.',
      'I need to read the full Dropdown.tsx and TokenUsageDisplay.tsx files.',
      'Let me read the key files I need to modify.',
    ].join(' ');
    assert.equal(hasIncompleteActionNarration(text), true);
    assert.equal(shouldRetryNoToolResponse(text), true);
  });

  it('retries Chinese file-read preambles instead of sendDone', () => {
    const text = [
      '好的，用户让我继续推进 task-3。我需要：',
      '1. 修改 TokenUsageDisplay 组件。',
      '2. 修改 ChatSurface 中 modelOptions 的构造方式。',
      '让我先读取这两个文件的完整内容，然后做修改。',
      '好，现在改调用方。先完整读两个文件。',
    ].join('\n');
    assert.equal(hasIncompleteActionNarration(text), true);
    assert.equal(shouldRetryNoToolResponse(text), true);
  });

  it('retries Goal Runner locate-gate narration from the stalled session', () => {
    const text = '继续推进计划。现在读 `isQualityReady` 定义与 pending 写入分支。先精确读取这两个定义。用 read_file 一次拉全。';
    assert.equal(hasIncompleteActionNarration(text), true);
    assert.equal(shouldRetryNoToolResponse(text), true);
  });

  it('does not treat command names in unrelated planning as incomplete file reads', () => {
    assert.equal(hasIncompleteActionNarration('Let me run pnpm test and then check git status.'), false);
  });

  it('retries past-tense execution claims that had no tool call', () => {
    assert.equal(hasUnsupportedToolClaim('I ran git status and checked the files.'), true);
    assert.equal(shouldRetryNoToolResponse('I ran git status and checked the files.'), true);
    assert.equal(shouldRetryNoToolResponse('我检查了：不是工具失败。'), true);
  });

  it('does not treat a write-later coding plan as empty write narration', () => {
    assert.equal(shouldRetryNoToolResponse('OK，开始写代码。我会先写 CascadingMenu.tsx。'), false);
  });

  it('still returns false for a clean normal answer', () => {
    assert.equal(shouldRetryNoToolResponse('Here is the explanation you asked for.'), false);
  });
});

describe('empty write narration guard', () => {
  it('detects Chinese empty-write progress claims', () => {
    assert.equal(hasEmptyWriteNarration('正在写入完整调研文档。'), true);
    assert.equal(hasEmptyWriteNarration('正在把结论写成调研文档'), true);
    assert.equal(hasEmptyWriteNarration('开始写入调研文档'), true);
    assert.equal(hasUnsupportedToolClaim('正在写入完整调研文档。'), true);
  });

  it('retries empty write narration so the model emits a real write tool call', () => {
    assert.equal(shouldRetryNoToolResponse('正在写入完整调研文档。'), true);
    assert.equal(shouldRetryNoToolResponse('Now writing the full document with the research findings.'), true);
  });

  it('does not treat normal coding plans as empty write narration', () => {
    assert.equal(hasEmptyWriteNarration('OK，开始写代码。我会先写 CascadingMenu.tsx。'), false);
    assert.equal(shouldRetryNoToolResponse('OK，开始写代码。我会先写 CascadingMenu.tsx。'), false);
    assert.equal(shouldRetryNoToolResponse('I will write the component next.'), false);
  });

  it('correction text requires real tool calls and 32KB chunked writes', () => {
    const correction = unsupportedToolResponseCorrection();
    assert.match(correction, /read_file|write_file or edit_file/i);
    assert.match(correction, /32KB/);
    assert.match(correction, /chunked writes/i);
    assert.match(correction, /开始写入|正在写入/);
  });
});
