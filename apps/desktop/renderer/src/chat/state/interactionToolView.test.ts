import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseInteractionToolView } from './interactionToolView.ts';

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
});
