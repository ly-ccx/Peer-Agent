/** Session-only public display history. A gap stays explicit until a real page overlaps. */
export function createRemoteHistory() {
  const rows = new Map();
  let order = [], nextCursor = null, gapBefore = null, resumeCursor = null, gapKnown = null;
  return {
    snapshot: () => ({ messages: order.map(id => rows.get(id)), nextCursor, gapBefore }),
    accept(page, older = false) {
      if (!page || !Array.isArray(page.messages)) throw Error('UNAVAILABLE');
      if (page.messages.some(row => typeof row?.id !== 'string' || !row.id)) throw Error('UNAVAILABLE');
      if (!older && gapBefore) throw Error('HISTORY_GAP_PENDING');
      const incoming = [...new Map(page.messages.filter(row => typeof row?.id === 'string' && row.id).map(row => [row.id, row])).values()];
      const ids = incoming.map(row => row.id), cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null;
      if (older && nextCursor && cursor === nextCursor) throw Error('CURSOR_STALLED');
      if (older && gapKnown && !cursor && !ids.some(id => gapKnown.has(id))) throw Error('HISTORY_GAP_UNRESOLVED');
      const overlaps = ids.some(id => rows.has(id));
      if (!older && order.length && incoming.length && !overlaps && cursor) {
        if (!gapBefore) { resumeCursor = nextCursor; gapKnown = new Set(order); }
        gapBefore = ids[0]; nextCursor = cursor;
      } else if (!older && !overlaps && !cursor) {
        rows.clear(); order = []; gapBefore = null; gapKnown = null;
      }
      const insertAt = older ? gapBefore ? Math.max(0, order.indexOf(gapBefore)) : 0 : order.length;
      if (!overlaps) order.splice(insertAt, 0, ...ids);
      else for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (order.includes(id)) continue;
        const previous = ids.slice(0, i).reverse().find(value => order.includes(value));
        const next = ids.slice(i + 1).find(value => order.includes(value));
        order.splice(previous ? order.indexOf(previous) + 1 : next ? order.indexOf(next) : order.length, 0, id);
      }
      for (const row of incoming) rows.set(row.id, row);
      if (older && gapKnown && ids.some(id => gapKnown.has(id))) {
        gapBefore = null; gapKnown = null; nextCursor = resumeCursor; resumeCursor = null;
      } else if (older) {
        nextCursor = cursor;
        if (gapBefore && ids.length) gapBefore = ids[0];
        if (!cursor) { gapBefore = null; gapKnown = null; }
      } else if (order.length === ids.length || !overlaps && !cursor) nextCursor = cursor;
      return this.snapshot();
    },
  };
}
