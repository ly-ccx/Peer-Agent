export const LOCAL_IMAGE_CONTEXT_PREFIX = '[Local image observation] ';

/** Preserve metadata/tool pairing, but never persist transient local pixels. */
export function checkpointWithoutLocalImagePixels(messages) {
  function copy(value) {
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const part = value[i];
        result.push(copy(part));
        const text = part?.type === 'text' ? part.text : part?.text;
        const next = value[i + 1];
        if (typeof text === 'string' && text.startsWith(LOCAL_IMAGE_CONTEXT_PREFIX) && (next?.type === 'image_url' || next?.type === 'image' || next?.inlineData)) {
          result.push(part?.type === 'text'
            ? { type: 'text', text: 'Local image pixels omitted from this checkpoint. Re-read the source with view_image before making a visual judgment.' }
            : { text: 'Local image pixels omitted from this checkpoint. Re-read the source with view_image before making a visual judgment.' });
          i++;
        }
      }
      return result;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    return value;
  }
  return copy(messages);
}
