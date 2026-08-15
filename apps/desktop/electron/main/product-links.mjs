export const PRODUCT_LINK_KINDS = Object.freeze(['github', 'feedback', 'releaseNotes']);

export const PRODUCT_LINKS = Object.freeze({
  github: 'https://github.com/ly-ccx/Peer-Agent',
  feedback: 'https://github.com/ly-ccx/Peer-Agent/issues/new',
  releaseNotes: 'https://ly-ccx.github.io/Peer-Agent/changelog.html',
});

export function resolveProductLink(kind) {
  if (typeof kind !== 'string' || !PRODUCT_LINK_KINDS.includes(kind)) return null;
  const url = PRODUCT_LINKS[kind];
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

export function createProductLinkService({ openExternal } = {}) {
  if (typeof openExternal !== 'function') {
    throw new TypeError('openExternal must be a function');
  }

  return {
    async open(kind) {
      const url = resolveProductLink(kind);
      if (!url) return { ok: false, reason: 'unknown-kind' };
      await openExternal(url);
      return { ok: true, url };
    },
  };
}
