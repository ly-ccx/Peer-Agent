import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInteractionToolView,
  parseInteractionToolViewFromCandidates,
} from './interactionToolView.ts';

describe('parseInteractionToolView', () => {
  it('returns null for non request_user_input tools', () => {
    assert.equal(parseInteractionToolView('bash', '{"question":"x"}'), null);
  });

  it('returns null when result is missing or unparsable', () => {
    assert.equal(parseInteractionToolView('request_user_input', undefined), null);
    assert.equal(parseInteractionToolView('request_user_input', 'not json'), null);
  });

  it('returns null when there is no question', () => {
    assert.equal(parseInteractionToolView('request_user_input', '{"options":["a"]}'), null);
  });

  it('extracts question, options and note', () => {
    const view = parseInteractionToolView(
      'request_user_input',
      JSON.stringify({ question: '选哪个？', options: ['A', 'B'], note: '已停止等待' }),
    );
    assert.ok(view);
    assert.equal(view.question, '选哪个？');
    assert.deepEqual(view.options, ['A', 'B']);
    assert.equal(view.note, '已停止等待');
  });

  it('tolerates missing/!string options', () => {
    const view = parseInteractionToolView(
      'request_user_input',
      JSON.stringify({ question: 'q', options: ['ok', 1, null, 'fine'] }),
    );
    assert.ok(view);
    assert.deepEqual(view.options, ['ok', 'fine']);
  });

  it('accepts object result payloads', () => {
    const view = parseInteractionToolView(
      'request_user_input',
      { question: '继续吗？', options: ['继续', '暂停'] },
    );
    assert.ok(view);
    assert.equal(view.question, '继续吗？');
    assert.deepEqual(view.options, ['继续', '暂停']);
  });

  it('matches request_user_input from candidate tool names and candidate results', () => {
    const view = parseInteractionToolViewFromCandidates(
      ['tool_call_1', 'request_user_input'],
      [undefined, JSON.stringify({ question: '选项？', options: ['A'] })],
    );
    assert.ok(view);
    assert.equal(view.question, '选项？');
    assert.deepEqual(view.options, ['A']);
  });

  it('matches namespaced request_user_input tool names', () => {
    const view = parseInteractionToolViewFromCandidates(
      ['local.interaction.request_user_input'],
      [{ question: '继续执行吗？', options: ['继续', '暂停'] }],
    );
    assert.ok(view);
    assert.equal(view.question, '继续执行吗？');
    assert.deepEqual(view.options, ['继续', '暂停']);
  });

  it('prefers request arguments when result content is truncated JSON', () => {
    const view = parseInteractionToolViewFromCandidates(
      ['request_user_input'],
      [
        { question: '需要确认吗？', options: ['继续', '停止'] },
        '{"ok":true,"question":"需要确认吗？',
      ],
    );

    assert.ok(view);
    assert.equal(view.question, '需要确认吗？');
    assert.deepEqual(view.options, ['继续', '停止']);
  });

  it('parses a complete interaction stream result without options', () => {
    const view = parseInteractionToolViewFromCandidates(
      ['local.interaction.request_user_input'],
      [JSON.stringify({ ok: true, acknowledged: true, question: '请确认是否继续' })],
    );

    assert.ok(view);
    assert.equal(view.question, '请确认是否继续');
    assert.deepEqual(view.options, []);
  });
});
