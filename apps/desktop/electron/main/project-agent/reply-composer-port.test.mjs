import assert from 'node:assert/strict';
import test from 'node:test';

import { createDesktopReplyComposer } from './reply-composer-port.mjs';
import { installDeliveryFacts, liveDeliveryFacts } from './delivery-facts-port.mjs';

const view = {
  turnId: 'turn-1',
  toolCallOrdinal: 1,
  workspaceId: 'ws-1',
  messages: [{ id: 'u1', kind: 'user_input', role: 'user', content: '做一下' }],
};

function composer() {
  return createDesktopReplyComposer({
    readDelivery: (input) => liveDeliveryFacts().read(input),
  });
}

test('回复按本机器人档位和安静时段送达', () => {
  installDeliveryFacts({
    read: () => ({ proactivity: 'high', botLevel: 'muted', quietHours: true }),
  });
  const muted = composer().postReply({ text: '先记一笔', replyTo: ['u1'] }, view);
  assert.equal(muted.error, undefined);
  assert.equal(muted.surfacing, 'silent');

  installDeliveryFacts({
    read: () => ({ proactivity: 'standard', quietHours: true }),
  });
  const quiet = composer().postReply({ text: '做完了', replyTo: ['u1'] }, view);
  assert.equal(quiet.surfacing, 'message');

  installDeliveryFacts({
    read: () => ({ proactivity: 'standard', quietHours: false }),
  });
  const standard = composer().postReply({ text: '做完了', replyTo: ['u1'] }, view);
  assert.equal(standard.surfacing, 'interrupt');
  installDeliveryFacts(null);
});
