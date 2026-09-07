/** Resolve only parser-proven text. Never search the source for a display string. */
export function resolveSelectionSource(body: Element, range: Range): { text: string; start: number; end: number } | null {
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
  if (!body.classList.contains('markdown-content')) {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(body);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    return { text: body.textContent ?? '', start, end: start + range.toString().length };
  }
  const text = body.getAttribute('data-selection-source');
  if (text === null) return null;
  const point = (node: Node, offset: number): number | null => {
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const span = node.parentElement?.closest('[data-source-offsets]');
    if (!span || !body.contains(span) || span.childNodes.length !== 1 || span.firstChild !== node) return null;
    let offsets: unknown;
    try { offsets = JSON.parse(span.getAttribute('data-source-offsets') ?? 'null'); } catch { return null; }
    const value = node.textContent ?? '';
    if (!Array.isArray(offsets) || offsets.length !== value.length + 1 || offset < 0 || offset > value.length) return null;
    for (let i = 0; i < offsets.length; i += 1) {
      const position = offsets[i];
      if (!Number.isInteger(position) || position < 0 || position > text.length || (i > 0 && position <= offsets[i - 1])) return null;
      if (i < value.length && text[position] !== value[i]) return null;
    }
    return offsets[offset];
  };
  const start = point(range.startContainer, range.startOffset);
  const end = point(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  // A cross-node selection must not silently include an unmapped display widget.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (range.intersectsNode(node) && node.textContent && point(node, 0) === null) return null;
  }
  return { text, start, end };
}
