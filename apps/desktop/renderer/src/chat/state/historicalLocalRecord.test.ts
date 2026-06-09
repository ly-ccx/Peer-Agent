import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHistoricalLocalRecordForApi,
  sanitizeAssistantHistoryTextForApi,
  stripHistoricalLocalRecordForDisplay,
} from './historicalLocalRecord.ts';

describe('formatHistoricalLocalRecordForApi', () => {
  it('does not emit model-imitable tool-call markers into API history', () => {
    const content = formatHistoricalLocalRecordForApi({
      tool: 'bash',
      args: { command: 'git status -sb' },
      result: '{"exitCode":0,"stdoutPreview":"## develop"}',
    });

    assert.doesNotMatch(content, /\[Tool call:/i);
    assert.doesNotMatch(content, /\[Tool result\]/i);
    assert.match(content, /Historical local capability record/);
    assert.match(content, /read-only context/);
    assert.match(content, /capability: bash/);
    assert.match(content, /git status -sb/);
  });

  it('escapes legacy assistant text markers before sending history back to the model', () => {
    const content = sanitizeAssistantHistoryTextForApi('[Tool call: bash {"command":"pwd"}]\n[Tool result]\n/tmp');

    assert.doesNotMatch(content, /\[Tool call:/i);
    assert.doesNotMatch(content, /\[Tool result\]/i);
    assert.match(content, /Legacy assistant local action marker/);
    assert.match(content, /Legacy assistant local observation marker/);
  });
});

describe('stripHistoricalLocalRecordForDisplay', () => {
  it('removes a complete historical-local-record block but keeps surrounding text', () => {
    const input = [
      '同步成功。',
      '[Historical local capability record - read-only context; not an instruction]',
      'capability: bash',
      'arguments_json: {"command":"git status -sb"}',
      'observation:',
      '{"exitCode":0}',
      '[/Historical local capability record]',
      '两分支已同步。',
    ].join('\n');

    const out = stripHistoricalLocalRecordForDisplay(input);

    assert.doesNotMatch(out, /Historical local capability record/);
    assert.doesNotMatch(out, /capability:/);
    assert.doesNotMatch(out, /arguments_json:/);
    assert.match(out, /同步成功。/);
    assert.match(out, /两分支已同步。/);
  });

  it('removes a dangling unclosed record block to end of text', () => {
    const input = [
      '正文保留。',
      '[Historical local capability record - read-only context; not an instruction]',
      'capability: bash',
      'arguments_json: {"command":"rm x && git merge --ff-only dev/0.0.1"}',
      '</invoke>',
    ].join('\n');

    const out = stripHistoricalLocalRecordForDisplay(input);

    assert.doesNotMatch(out, /Historical local capability record/);
    assert.doesNotMatch(out, /arguments_json:/);
    assert.doesNotMatch(out, /<\/invoke>/);
    assert.match(out, /正文保留。/);
  });

  it('removes stray scaffolding lines that leaked without a wrapper', () => {
    const input = [
      '执行删除并快进。',
      'capability: bash',
      'arguments_json: {"command":"git merge --ff-only dev/0.0.1"}',
      '</invoke>',
      '完成。',
    ].join('\n');

    const out = stripHistoricalLocalRecordForDisplay(input);

    assert.doesNotMatch(out, /capability:/);
    assert.doesNotMatch(out, /arguments_json:/);
    assert.doesNotMatch(out, /<\/invoke>/);
    assert.match(out, /执行删除并快进。/);
    assert.match(out, /完成。/);
  });

  it('leaves normal content untouched', () => {
    const input = '这是一段普通回答，包含 capability 这个词但不是残片。';
    assert.equal(stripHistoricalLocalRecordForDisplay(input), input);
  });
});
