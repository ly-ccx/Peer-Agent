import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatHistoricalLocalRecordForApi, sanitizeAssistantHistoryTextForApi } from './historicalLocalRecord.ts';

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
