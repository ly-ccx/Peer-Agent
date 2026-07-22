import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  __setComposerSettingsPort,
  clearComposerEntry,
  flushComposerPersistence,
  loadComposerEntry,
  resolveComposerHydration,
  saveComposerEntry,
  shouldDeferEmptyComposerSave,
  type ComposerSettingsPort,
} from './composerPersistence.ts';

interface FakePort extends ComposerSettingsPort {
  writes: Record<string, unknown>[];
}

function makePort(initial: Record<string, unknown>): FakePort {
  const writes: Record<string, unknown>[] = [];
  return {
    writes,
    readInitialSettings: () => initial,
    updateSettings: (partial) => {
      writes.push(partial);
    },
  };
}

describe('composerPersistence', () => {
  afterEach(() => {
    __setComposerSettingsPort(null);
  });

  it('restores a persisted draft and queue from initial settings', () => {
    __setComposerSettingsPort(
      makePort({
        composerDrafts: {
          'conv-1': {
            draft: 'hello world',
            queue: [{ id: 'q1', text: 'queued one', attachments: [], effort: 'default' }],
          },
        },
      }),
    );

    const entry = loadComposerEntry('conv-1');
    assert.ok(entry);
    assert.equal(entry.draft, 'hello world');
    assert.equal(entry.queue.length, 1);
    assert.equal(entry.queue[0].text, 'queued one');
    assert.equal(loadComposerEntry('conv-unknown'), null);
  });

  it('persists draft + queue under the conversation id', () => {
    const port = makePort({});
    __setComposerSettingsPort(port);

    saveComposerEntry('conv-9', {
      draft: 'work in progress',
      queue: [{ id: 'q1', text: 'next message', attachments: [], effort: 'high' }],
    });
    flushComposerPersistence();

    assert.equal(port.writes.length, 1);
    const written = port.writes[0].composerDrafts as Record<string, unknown>;
    const saved = written['conv-9'] as { draft: string; queue: unknown[] };
    assert.equal(saved.draft, 'work in progress');
    assert.equal(saved.queue.length, 1);
    // 写回后内存即可读到，无需等 initialSettings 回填。
    assert.equal(loadComposerEntry('conv-9')?.draft, 'work in progress');
  });

  it('drops the entry when draft and queue are both empty', () => {
    const port = makePort({
      composerDrafts: { 'conv-2': { draft: 'stale', queue: [] } },
    });
    __setComposerSettingsPort(port);

    saveComposerEntry('conv-2', { draft: '', queue: [] });
    flushComposerPersistence();

    assert.equal(port.writes.length, 1);
    const written = port.writes[0].composerDrafts as Record<string, unknown>;
    assert.equal('conv-2' in written, false);
    assert.equal(loadComposerEntry('conv-2'), null);
  });

  it('ignores empty saves for conversations with no existing entry', () => {
    const port = makePort({});
    __setComposerSettingsPort(port);

    saveComposerEntry('conv-empty', { draft: '', queue: [] });
    flushComposerPersistence();

    assert.equal(port.writes.length, 0);
  });

  it('clearComposerEntry removes a persisted entry', () => {
    const port = makePort({
      composerDrafts: { 'conv-3': { draft: 'bye', queue: [] } },
    });
    __setComposerSettingsPort(port);

    clearComposerEntry('conv-3');
    flushComposerPersistence();

    assert.equal(port.writes.length, 1);
    const written = port.writes[0].composerDrafts as Record<string, unknown>;
    assert.equal('conv-3' in written, false);
  });

  it('defers only the pre-hydration empty save that would erase persisted queue data', () => {
    const persisted = {
      draft: '',
      queue: [{ id: 'q1', text: 'queued', attachments: [], effort: 'default' as const }],
    };

    assert.equal(shouldDeferEmptyComposerSave(false, '', [], persisted), true);
    assert.equal(shouldDeferEmptyComposerSave(true, '', [], persisted), false);
    assert.equal(shouldDeferEmptyComposerSave(false, 'edited', [], persisted), false);
    assert.equal(shouldDeferEmptyComposerSave(false, '', [{ id: 'live' }], persisted), false);
    assert.equal(shouldDeferEmptyComposerSave(false, '', [], null), false);
  });

  it('resolveComposerHydration prefers live queue/draft over empty or stale persistence', () => {
    const liveQueue = [{ id: 'q-live', text: 'still queued', attachments: [], effort: 'default' }];
    const live = resolveComposerHydration(
      { draft: '', messageQueue: liveQueue },
      { draft: '', queue: [] },
    );
    assert.equal(live.source, 'live');
    assert.equal(live.queue, liveQueue);

    const cold = resolveComposerHydration(
      { draft: '', messageQueue: [] },
      {
        draft: 'from disk',
        queue: [{ id: 'q1', text: 'persisted queue', attachments: [], effort: 'default' }],
      },
    );
    assert.equal(cold.source, 'persisted');
    assert.equal(cold.draft, 'from disk');
    assert.equal(cold.queue.length, 1);

    const empty = resolveComposerHydration({ draft: '', messageQueue: [] }, null);
    assert.equal(empty.source, 'persisted');
    assert.equal(empty.draft, '');
    assert.equal(empty.queue.length, 0);
  });
});
