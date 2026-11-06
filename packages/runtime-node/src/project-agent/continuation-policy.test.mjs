import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedProgressObservations } from './progress-policy.mjs';
import { continuationDecision } from './continuation-policy.mjs';

test('changing repair epochs and verification hashes alone cannot evade no-progress protection',()=>{
  let previous={};
  const rounds=(epoch,summary='unchanged result')=>[{toolCalls:[{name:'get_session',input:{sessionId:'s'},
    result:{status:'result_ready',summary,sourceRevision:`source-${epoch}`,observationRevision:`observed-${epoch}`,origin:{coordinationBinding:{executionEpoch:epoch}}}}]}];
  for(const epoch of ['one','two','three']) previous=continuationDecision({previous,rounds:rounds(epoch),yielded:true});
  assert.equal(previous.end,'no_progress');
  const changed=continuationDecision({previous,rounds:rounds('four','new concrete finding'),yielded:true});
  assert.equal(changed.end,'yielded');
  assert.equal(changed.repeats,0);
});


test('reading identical spilled tool facts through newly generated artifact wrappers cannot reset no-progress', () => {
  let previous = {};
  for (let n = 0; n < 4; n++) {
    const result = { kind: 'local_file_ref', tool: 'read_file', path: `/tmp/artifacts/get_session-call_abcdefghijklmno${n}.txt`,
      chars: 100, lines: 12, mtimeMs: n, contentHash: `wrapper-${n}`, fullRead: true,
      preview: '  1\t{\n  2\t  "sessionId": "s",\n  3\t  "status": "failed",\n  4\t  "lastError": "conversation_persistence_failed: CONVERSATION_MESSAGE_MISSING"\n  5\t}',
      evidenceRefs: [`tool-result://read-${n}`] };
    previous = continuationDecision({ previous, rounds: [{ toolCalls: [{ name: 'read_file', input: { path: result.path }, result }] }], yielded: true });
  }
  assert.equal(previous.state, 'blocked_system');
  assert.equal(previous.end, 'no_progress');
});

test('complete query artifact content changes count, while partial wrappers and ordinary file identities stay distinct', () => {
  const path = '/tmp/artifacts/get_session-call_abcdefghijklmnopqrstuvwx.txt';
  const read = (summary, extra = {}) => [{ toolCalls: [{ name: 'read_file', input: { path }, result: {
    kind: 'local_file_ref', tool: 'read_file', path, preview: JSON.stringify({ sessionId: 's', status: 'result_ready', summary }), ...extra,
  } }] }];
  let previous = {};
  for (let n = 0; n < 3; n++) previous = continuationDecision({ previous, yielded: true, rounds: read('same') });
  assert.equal(previous.end, 'no_progress');
  const changed = continuationDecision({ previous, yielded: true, rounds: read('new measured finding') });
  assert.equal(changed.end, 'yielded'); assert.equal(changed.repeats, 0);
  previous = {};
  for (let n = 0; n < 4; n++) previous = continuationDecision({ previous: structuredClone(previous), yielded: true,
    rounds: [{ toolCalls: [{ name: 'read_file', input: { path: path.replace('abcdefghijklmnopqrstuvwx', 'call' + n), start_line: n },
      result: { kind: 'local_file_ref', tool: 'read_file', truncated: true, originalChars: n + 100,
        evidenceRefs: ['tool-result://new-' + n], outputPreview: { preview: '{"partial":' + n } } }] }] });
  assert.equal(previous.end, 'no_progress');
  const ordinary = (path, hash) => [{ toolCalls: [{ name: 'read_file', input: { path },
    result: { kind: 'local_file_ref', tool: 'read_file', path, contentHash: hash, preview: 'same prefix' } }] }];
  const first = continuationDecision({ yielded: true, rounds: ordinary('/work/a.txt', 'a') });
  assert.equal(continuationDecision({ previous: first, yielded: true, rounds: ordinary('/work/a.txt', 'b') }).repeats, 0);
  assert.equal(continuationDecision({ previous: first, yielded: true, rounds: ordinary('/work/b.txt', 'a') }).repeats, 0);
});


test('a copied execution receipt in a query file remains an observation', () => {
  const path = '/tmp/artifacts/get_session-call_abcdefghijklmnopqrstuvwx.txt';
  const rows = normalizedProgressObservations([{ toolCalls: [{ name: 'read_file', input: { path }, result: {
    kind: 'local_file_ref', tool: 'read_file', path, preview: JSON.stringify({ sessionId: 's', phase: 'completed', executionEffect: 'applied' }),
  } }] }]);
  assert.equal(rows[0].kind, 'observed');
});
