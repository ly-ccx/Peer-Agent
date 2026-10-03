/** Decode only the root text string. Never infer execution facts from unfinished JSON. */
export function readReplyTextPreview(json) {
  if (typeof json !== 'string' || json.length > 128_000) return null;
  let depth = 0;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '{' || char === '[') { depth++; continue; }
    if (char === '}' || char === ']') { depth--; continue; }
    if (char !== '"') continue;
    const key = stringAt(json, i);
    if (!key.complete) return null;
    i = key.end;
    if (depth !== 1 || key.text !== 'text') continue;
    let next = i + 1;
    while (/\s/.test(json[next] || '') && next < json.length) next++;
    if (json[next++] !== ':') continue;
    while (/\s/.test(json[next] || '') && next < json.length) next++;
    if (json[next] !== '"') return null;
    const value = stringAt(json, next);
    return value.valid ? safePrefix(value.text.slice(0, 2000)) : null;
  }
  return null;
}

function stringAt(json, start) {
  let text = '', end = start;
  for (let i = start + 1; i < json.length; i++) {
    end = i;
    const char = json[i];
    if (char === '"') return { text: safePrefix(text), end, complete: true, valid: true };
    if (char === '\\') {
      const code = json[++i];
      if (!code) break;
      if (code === 'u') {
        const hex = json.slice(i + 1, i + 5);
        if (hex.length < 4) break;
        if (!/^[0-9a-f]{4}$/i.test(hex)) return { valid: false };
        text += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else {
        const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(code in escapes)) return { valid: false };
        text += escapes[code];
      }
    } else {
      if (char.charCodeAt(0) < 32) return { valid: false };
      text += char;
    }
  }
  return { text: safePrefix(text), end, complete: false, valid: true };
}

function safePrefix(text) {
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}
