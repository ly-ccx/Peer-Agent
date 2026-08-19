import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCT_LINK_KINDS,
  PRODUCT_LINKS,
  createProductLinkService,
  resolveProductLink,
} from './product-links.mjs';

test('resolves only the allowlisted product link kinds', () => {
  assert.deepEqual([...PRODUCT_LINK_KINDS], ['github', 'feedback', 'releaseNotes']);
  assert.equal(resolveProductLink('github'), PRODUCT_LINKS.github);
  assert.equal(resolveProductLink('feedback'), PRODUCT_LINKS.feedback);
  assert.equal(resolveProductLink('releaseNotes'), PRODUCT_LINKS.releaseNotes);
  assert.equal(resolveProductLink('https://evil.example'), null);
  assert.equal(resolveProductLink('github.com'), null);
  assert.equal(resolveProductLink(''), null);
  assert.equal(resolveProductLink(null), null);
});

test('opens allowlisted https urls and rejects unknown kinds', async () => {
  const opened = [];
  const service = createProductLinkService({
    openExternal: async (url) => {
      opened.push(url);
    },
  });

  assert.deepEqual(await service.open('github'), { ok: true, url: PRODUCT_LINKS.github });
  assert.deepEqual(await service.open('javascript:alert(1)'), { ok: false, reason: 'unknown-kind' });
  assert.deepEqual(opened, [PRODUCT_LINKS.github]);
  assert.match(PRODUCT_LINKS.github, /^https:\/\/github\.com\/ly-ccx\/Peer-Agent$/);
  assert.match(PRODUCT_LINKS.feedback, /^https:\/\/github\.com\/ly-ccx\/Peer-Agent\/issues\/new$/);
  assert.match(PRODUCT_LINKS.releaseNotes, /^https:\/\/ly-ccx\.github\.io\/Peer-Agent\/changelog\.html$/);
});
