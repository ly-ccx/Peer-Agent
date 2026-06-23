import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEntities,
  parseReleaseNotesHtml,
  nodesToPlainText,
  type ReleaseNotesNode,
} from './releaseNotesHtml.ts';

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
  });
  it('decodes numeric and hex entities', () => {
    assert.equal(decodeEntities('&#39;&#x27;'), "''");
  });
  it('leaves unknown entities untouched', () => {
    assert.equal(decodeEntities('&unknownthing;'), '&unknownthing;');
  });
});

describe('parseReleaseNotesHtml', () => {
  it('parses a simple paragraph', () => {
    const nodes = parseReleaseNotesHtml('<p>Release 0.0.1-beta.6 (beta)</p>');
    assert.equal(nodes.length, 1);
    const p = nodes[0] as Extract<ReleaseNotesNode, { kind: 'element' }>;
    assert.equal(p.kind, 'element');
    assert.equal(p.tag, 'p');
    assert.equal(nodesToPlainText(nodes), 'Release 0.0.1-beta.6 (beta)');
  });

  it('parses lists with items', () => {
    const nodes = parseReleaseNotesHtml('<ul><li>one</li><li>two</li></ul>');
    assert.equal(nodes.length, 1);
    const ul = nodes[0] as Extract<ReleaseNotesNode, { kind: 'element' }>;
    assert.equal(ul.tag, 'ul');
    assert.equal(ul.children.length, 2);
    assert.equal(ul.children.every((c) => c.kind === 'element' && c.tag === 'li'), true);
  });

  it('normalizes b/i to strong/em', () => {
    const nodes = parseReleaseNotesHtml('<p><b>bold</b> and <i>italic</i></p>');
    const p = nodes[0] as Extract<ReleaseNotesNode, { kind: 'element' }>;
    const tags = p.children
      .filter((c): c is Extract<ReleaseNotesNode, { kind: 'element' }> => c.kind === 'element')
      .map((c) => c.tag);
    assert.deepEqual(tags, ['strong', 'em']);
  });

  it('keeps safe http/mailto links and drops unsafe protocols', () => {
    const safe = parseReleaseNotesHtml('<a href="https://example.com">x</a>');
    const a = safe[0] as Extract<ReleaseNotesNode, { kind: 'element' }>;
    assert.equal(a.tag, 'a');
    assert.equal(a.href, 'https://example.com');

    const unsafe = parseReleaseNotesHtml('<a href="javascript:alert(1)">x</a>');
    const a2 = unsafe[0] as Extract<ReleaseNotesNode, { kind: 'element' }>;
    assert.equal(a2.tag, 'a');
    assert.equal(a2.href, undefined);
  });

  it('strips non-whitelisted tags but keeps their content (drops script payload tags)', () => {
    const nodes = parseReleaseNotesHtml('<div><script>evil()</script><p>safe</p></div>');
    // script/div are not whitelisted → unwrapped; text "evil()" survives as text but no element.
    const hasElement = (list: ReleaseNotesNode[], tag: string): boolean =>
      list.some(
        (n) =>
          (n.kind === 'element' && n.tag === tag) ||
          (n.kind === 'element' && hasElement(n.children, tag)),
      );
    assert.equal(hasElement(nodes, 'script' as never), false);
    assert.equal(hasElement(nodes, 'div' as never), false);
    assert.equal(hasElement(nodes, 'p'), true);
    assert.match(nodesToPlainText(nodes), /safe/);
  });

  it('treats plain text (no tags) as a text node', () => {
    const nodes = parseReleaseNotesHtml('just plain text');
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].kind, 'text');
    assert.equal(nodesToPlainText(nodes), 'just plain text');
  });

  it('handles void br element', () => {
    const nodes = parseReleaseNotesHtml('<p>a<br/>b</p>');
    assert.equal(nodesToPlainText(nodes), 'a\nb');
  });

  it('decodes entities inside text', () => {
    const nodes = parseReleaseNotesHtml('<p>a &amp; b</p>');
    assert.equal(nodesToPlainText(nodes), 'a & b');
  });
});
