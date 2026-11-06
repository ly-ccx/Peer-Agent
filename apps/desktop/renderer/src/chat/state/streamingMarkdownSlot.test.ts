import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMarkdownBlocks } from '../components/markdown/markdownParser.ts';
import {
  advanceMarkdownOpenSlot,
  nextStreamingTextSegment,
  openFenceBody,
  readStreamingOpenSlot,
} from './streamingMarkdownSlot.ts';

describe('streaming markdown open slot', () => {
  it('keeps already closed blocks stable while a fence is still growing', () => {
    let source = 'Intro paragraph.\n\n';
    let slot = advanceMarkdownOpenSlot(undefined, source);
    assert.equal(slot.openKind, 'empty');
    assert.equal(slot.closed.length, 1);
    assert.equal(slot.closed[0]?.type, 'paragraph');
    const closed = slot.closed;

    for (const chunk of ['```ts\n', 'const a = 1;\n', 'const b = 2;\n']) {
      source += chunk;
      const next = advanceMarkdownOpenSlot(slot, source);
      assert.equal(next.closed, closed, 'closed block array must keep its identity');
      assert.equal(next.closed[0], closed[0]);
      assert.equal(next.openKind, 'fence');
      assert.equal(next.fenceLanguage, 'ts');
      slot = next;
    }

    const body = openFenceBody(slot.openText);
    assert.equal(body?.language, 'ts');
    assert.match(body?.code ?? '', /const b = 2/);
    assert.equal(slot.openText.includes('Intro'), false);
  });

  it('commits a fence once the closer arrives and only reparses that new block', () => {
    let source = 'Before.\n\n```js\nconsole.log(1);\n';
    let slot = advanceMarkdownOpenSlot(undefined, source);
    const closed = slot.closed;
    assert.equal(slot.openKind, 'fence');

    source += '```\n';
    slot = advanceMarkdownOpenSlot(slot, source);
    assert.equal(slot.openKind, 'empty');
    assert.equal(slot.closed[0], closed[0]);
    assert.notEqual(slot.closed, closed);
    const closedFence = slot.closed.at(-1);
    assert.equal(closedFence?.type, 'code');
    if (closedFence?.type === 'code') {
      assert.equal(closedFence.language, 'js');
      assert.match(closedFence.content, /console\.log\(1\)/);
    }

    source += 'After.';
    const after = advanceMarkdownOpenSlot(slot, source);
    assert.equal(after.closed, slot.closed);
    assert.equal(after.openKind, 'prose');
    assert.equal(after.openText, 'After.');
  });

  it('matches a full parse once every block has closed', () => {
    const chunks = ['# Title\n\n', 'A paragraph.\n\n', '- one\n- two\n\n', '```ts\nconst x = 1;\n```\n\n', 'Done.\n'];
    let source = '';
    let slot = advanceMarkdownOpenSlot(undefined, source);
    for (const chunk of chunks) {
      source += chunk;
      slot = advanceMarkdownOpenSlot(slot, source);
    }
    // 末尾「Done.\n」只有一个换行，段落还能续写，所以留在开放尾。
    assert.equal(slot.openKind, 'prose');
    assert.match(slot.openText, /^Done\./);
    const full = parseMarkdownBlocks(source);
    const streamed = [
      ...slot.closed,
      ...parseMarkdownBlocks(slot.openText),
    ];
    assert.deepEqual(
      streamed.map((block) => block.type),
      full.map((block) => block.type),
    );
    assert.equal(slot.closed.filter((block) => block.type === 'code').length, 1);
  });

  it('does not close a paragraph on a single trailing newline', () => {
    let source = 'hello';
    let slot = advanceMarkdownOpenSlot(undefined, source);
    source += '\n';
    slot = advanceMarkdownOpenSlot(slot, source);
    assert.equal(slot.closed.length, 0);
    assert.equal(slot.openKind, 'prose');

    source += ' world';
    slot = advanceMarkdownOpenSlot(slot, source);
    assert.equal(slot.closed.length, 0);
    assert.match(slot.openText, /hello\n world/);

    source += '\n\n';
    slot = advanceMarkdownOpenSlot(slot, source);
    assert.equal(slot.openKind, 'empty');
    assert.equal(slot.closed.length, 1);
    assert.equal(slot.closed[0]?.type, 'paragraph');
  });

  it('does not treat an unclosed fence as a closed code block', () => {
    const slot = advanceMarkdownOpenSlot(undefined, '```py\nprint(1)\nprint(2)\n');
    assert.equal(slot.closed.length, 0);
    assert.equal(slot.openKind, 'fence');
    assert.equal(slot.closed.some((block) => block.type === 'code'), false);
  });

  it('attaches the slot to the segment object without making it durable', () => {
    const first = nextStreamingTextSegment(undefined, 'Hello\n\n');
    const second = nextStreamingTextSegment(first, 'Hello\n\n```js\nconst a = 1;\n');
    const slot = readStreamingOpenSlot(second);
    assert.equal(slot?.openKind, 'fence');
    assert.equal(slot?.closed.length, 1);
    assert.equal(readStreamingOpenSlot(first)?.openKind, 'empty');
    assert.equal(JSON.stringify(second).includes('openKind'), false);
    assert.equal(JSON.stringify(second).includes('closed'), false);
  });
});
