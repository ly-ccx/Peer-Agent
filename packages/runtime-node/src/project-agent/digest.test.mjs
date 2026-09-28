import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decideSurfacing } from '@peer-agent/protocol';

import {
  createDigestQueue,
  digestSeparator,
  inQuietHours,
  normalizeProjectAgentSettings,
  planDelivery,
} from './digest.mjs';

const PROTOCOL = { quiet: 'off', low: 'low', standard: 'normal', high: 'high' };

function delivery(event, proactivity, extra = {}) {
  return planDelivery({ event, proactivity, foreground: false, ...extra });
}

test('规则表每一行按产品档位送达', () => {
  const attention = ['needs_user', 'confirm', 'failure_needs_decision', 'objective_risk'];
  for (const kind of attention) {
    assert.equal(
      delivery({ origin: 'user_request', kind, novelty: true, severity: 'info' }, 'quiet').decision,
      'interrupt',
    );
  }
  for (const level of ['quiet', 'low']) {
    assert.equal(
      delivery({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, level).decision,
      'message',
    );
  }
  for (const level of ['standard', 'high']) {
    assert.equal(
      delivery({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, level).decision,
      'interrupt',
    );
  }
  assert.equal(
    delivery({ origin: 'agent_idea', kind: 'observation', novelty: false, severity: 'urgent' }, 'high').decision,
    'silent',
  );
  assert.equal(
    delivery({ origin: 'agent_idea', kind: 'observation', novelty: true, severity: 'urgent' }, 'quiet').decision,
    'interrupt',
  );
  const notable = { origin: 'agent_idea', kind: 'observation', novelty: true, severity: 'notable' };
  assert.equal(delivery(notable, 'quiet').decision, 'digest');
  assert.equal(delivery(notable, 'low').decision, 'digest');
  assert.equal(delivery(notable, 'standard').decision, 'message');
  assert.equal(delivery(notable, 'high').decision, 'interrupt');
  const info = { origin: 'agent_idea', kind: 'idea', novelty: true, severity: 'info' };
  assert.equal(delivery(info, 'quiet').decision, 'silent');
  assert.equal(delivery(info, 'low').decision, 'digest');
  assert.equal(delivery(info, 'standard').decision, 'digest');
  assert.equal(delivery(info, 'high').decision, 'message');

  for (const level of ['quiet', 'low', 'standard', 'high']) {
    const event = { origin: 'objective_signal', kind: 'observation', novelty: true, severity: 'notable' };
    assert.equal(
      delivery(event, level).decision,
      decideSurfacing({
        event,
        proactivity: PROTOCOL[level],
        foreground: false,
        quietHours: false,
        needsYou: false,
      }).decision,
    );
  }
});

test('送达方式决定进对话、未读、通知还是暂存', () => {
  const interrupt = delivery({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, 'standard');
  assert.equal(interrupt.notify, true);
  assert.equal(interrupt.unread, true);
  assert.equal(interrupt.conversation, true);
  assert.equal(interrupt.hold, false);
  const message = delivery({ origin: 'user_request', kind: 'result', novelty: true, severity: 'info' }, 'low');
  assert.equal(message.notify, false);
  assert.equal(message.unread, true);
  assert.equal(message.conversation, true);
  const digest = delivery({ origin: 'agent_idea', kind: 'observation', novelty: true, severity: 'notable' }, 'quiet');
  assert.equal(digest.hold, true);
  assert.equal(digest.conversation, false);
  assert.equal(digest.unread, false);
  const silent = delivery({ origin: 'agent_idea', kind: 'idea', novelty: true, severity: 'info' }, 'quiet');
  assert.equal(silent.conversation, true);
  assert.equal(silent.unread, false);
  assert.equal(silent.notify, false);
});

test('静音只放行需要你，安静时段把其余打断降成消息', () => {
  const needsYou = { origin: 'user_request', kind: 'needs_user', novelty: true, severity: 'info' };
  assert.equal(delivery(needsYou, 'muted').decision, 'interrupt');
  assert.equal(delivery(needsYou, 'muted', { quietHours: true }).decision, 'interrupt');
  assert.equal(
    delivery({ origin: 'agent_idea', kind: 'observation', novelty: true, severity: 'urgent' }, 'muted').decision,
    'silent',
  );
  const hours = { enabled: true, start: '22:00', end: '08:00' };
  assert.equal(inQuietHours(new Date(2026, 8, 27, 23, 0), hours), true);
  assert.equal(inQuietHours(new Date(2026, 8, 27, 12, 0), hours), false);
  assert.equal(inQuietHours(new Date(2026, 8, 27, 23, 0), { enabled: false, start: '22:00', end: '08:00' }), false);
  const urgent = { origin: 'agent_idea', kind: 'observation', novelty: true, severity: 'urgent' };
  assert.equal(delivery(urgent, 'high', { quietHours: true }).decision, 'message');
  assert.equal(delivery(urgent, 'high', { quietHours: true }).reason, 'quiet_hours');
  assert.equal(delivery(needsYou, 'quiet', { quietHours: true }).decision, 'interrupt');
  const deadline = {
    origin: 'objective_signal',
    kind: 'objective_risk',
    novelty: true,
    severity: 'urgent',
    deadlineImminent: true,
  };
  assert.equal(delivery(deadline, 'quiet', { quietHours: true }).decision, 'interrupt');
  assert.equal(delivery(deadline, 'muted').decision, 'interrupt');
  assert.equal(
    delivery({ ...deadline, deadlineImminent: false }, 'quiet', { quietHours: true }).decision,
    'message',
  );
});

test('今日小结到点合并，空队列跳过，同一天不重复', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b3-05-digest-'));
  try {
    const queue = createDigestQueue({ file: path.join(root, 'digest.json') });
    const early = new Date(2026, 8, 27, 8, 59);
    queue.hold('ws-1', { id: 'a', text: '登录修好了' });
    queue.hold('ws-1', { id: 'b', text: '文档补了一段' });
    assert.equal(queue.consider('ws-1', early, '09:00').reason, 'not_due');
    assert.equal(queue.pending('ws-1'), 2);

    const due = queue.consider('ws-1', new Date(2026, 8, 27, 9, 0), '09:00');
    assert.equal(due.fire, true);
    assert.equal(due.message.separatorLabel, digestSeparator('09:00'));
    assert.equal(due.message.separatorLabel, '今天 09:00 · 今日小结');
    assert.equal(due.message.content, '登录修好了\n文档补了一段');
    assert.equal(due.message.meta.digestDate, '2026-09-27');
    assert.equal(due.timer.kind, 'digest_due');
    assert.equal(due.timer.wake, true);
    assert.equal(queue.pending('ws-1'), 2);
    assert.equal(queue.consider('ws-1', new Date(2026, 8, 27, 18, 0), '09:00').fire, true);
    const crashed = createDigestQueue({ file: path.join(root, 'digest.json') });
    assert.equal(crashed.pending('ws-1'), 2);
    assert.equal(queue.acknowledge('ws-1', due.date), true);
    assert.equal(queue.pending('ws-1'), 0);
    assert.equal(queue.consider('ws-1', new Date(2026, 8, 27, 18, 0), '09:00').reason, 'not_due');

    const again = createDigestQueue({ file: path.join(root, 'digest.json') });
    assert.equal(again.consider('ws-1', new Date(2026, 8, 28, 9, 5), '09:00').reason, 'empty');
    assert.equal(again.consider('ws-1', new Date(2026, 8, 28, 10, 0), '09:00').reason, 'not_due');
    const stored = JSON.parse(readFileSync(path.join(root, 'digest.json'), 'utf8'));
    assert.equal(stored.fired['ws-1'], '2026-09-28');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺省设置是标准档、关闭的安静时段和 09:00', () => {
  assert.deepEqual(normalizeProjectAgentSettings(null), {
    proactivity: 'standard',
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    digestTime: '09:00',
    shell: 'bots',
    shellIntroPending: false,
    shellIntroDismissed: false,
  });
  assert.equal(normalizeProjectAgentSettings({ shell: 'classic' }).shell, 'classic');
  assert.equal(normalizeProjectAgentSettings({ shell: 'other' }).shell, 'bots');
  assert.equal(normalizeProjectAgentSettings({ proactivity: 'nope', digestTime: '9am' }).proactivity, 'standard');
  assert.equal(normalizeProjectAgentSettings({ proactivity: 'high', digestTime: '18:30' }).digestTime, '18:30');
});
