/** Explicit callback seam for non-UI inference; existing Desktop sinks stay compatible. */
export function emitProviderEvent(sink, channel, payload) {
  if (typeof sink === 'function') sink(channel, payload);
  else if (sink && !sink.isDestroyed?.()) sink.send?.(channel, payload);
}
