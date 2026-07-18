/**
 * Lightweight pre-parse cleanup for model-authored Markdown fences.
 *
 * v1 scope (high-confidence only):
 * 1. Strip fenced regions that are clearly prose (short Chinese labels), not code
 * 2. Close or strip unclosed fences depending on body shape
 * 3. Close path-style half-open inline backticks (`path/to/file.ts)
 *
 * Does NOT invent fences around bare code (too easy to mis-fire).
 */

function countCjk(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
}

function hasCodeSignals(text: string): boolean {
  return (
    /[{};<>]=|function\s|const\s|let\s|var\s|className=|=>|import\s|export\s|return\s/m.test(text) ||
    /^\s*[.#][\w-]+\s*\{/m.test(text) ||
    /<\/?[A-Za-z][\w:-]*[\s/>]/.test(text)
  );
}

/** True when a fenced body is almost certainly prose mis-wrapped as code. */
export function looksLikeProseNotCode(body: string): boolean {
  const t = body.trim();
  if (!t) return false;

  const lines = t.split('\n');
  if (lines.length > 3) return false;
  if (t.length > 120) return false;
  if (hasCodeSignals(t)) return false;

  const cjk = countCjk(t);
  // Chinese labels / short explanations (e.g. "样式是整行占满：")
  if (cjk >= 2) return true;
  // Short English caption ending with colon
  if (lines.length <= 2 && t.length < 40 && /[:：]\s*$/.test(t)) return true;

  return false;
}

function isFenceOpenLine(line: string): boolean {
  return Boolean(line.trim().match(/^```([A-Za-z0-9_-]+)?\s*$/));
}

function isFenceCloseLine(line: string): boolean {
  return line.trim().startsWith('```');
}

/**
 * Close high-confidence path-style half-open inline backticks.
 * Leaves other odd-backtick lines alone (InlineMarkdown already falls back safely).
 */
export function fixUnbalancedPathBacktick(line: string): string {
  if (isFenceCloseLine(line)) return line;

  const trimmed = line.trim();
  // Odd number of single backticks on the line
  const tickCount = (line.match(/`/g) ?? []).length;
  if (tickCount === 0 || tickCount % 2 === 0) return line;

  // High-confidence: whole (trimmed) line is one open ` + path-like token, no close
  // - `152:159:apps/.../file.tsx
  // - `path/to/file.ts
  // - `/abs/path/file.ts
  // - `./rel/path.tsx
  const pathOpen =
    /^`\d+:\d+:[^\s`]+$/.test(trimmed) ||
    /^`(?:\.\/|\.\.\/|~\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+$/.test(trimmed) ||
    /^`(?:\.\/|\.\.\/|~\/|\/)[^\s`]+\.[A-Za-z0-9]+$/.test(trimmed);

  if (!pathOpen) return line;

  // Preserve original trailing whitespace position by appending before EOL spaces
  const trailing = line.match(/\s*$/)?.[0] ?? '';
  const core = trailing ? line.slice(0, -trailing.length) : line;
  return `${core}\`${trailing}`;
}

/**
 * Sanitize fence / path-backtick mistakes before block parsing.
 */
export function sanitizeMarkdownFences(markdown: string): string {
  if (!markdown) return markdown;

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!isFenceOpenLine(line)) {
      out.push(fixUnbalancedPathBacktick(line));
      index += 1;
      continue;
    }

    const openLine = line;
    index += 1;
    const bodyLines: string[] = [];

    while (index < lines.length) {
      if (isFenceCloseLine(lines[index])) {
        index += 1;
        break;
      }
      bodyLines.push(lines[index]);
      index += 1;
    }

    const body = bodyLines.join('\n');

    if (looksLikeProseNotCode(body)) {
      // Drop the mistaken fence markers; keep body as normal text.
      for (const bodyLine of bodyLines) {
        out.push(fixUnbalancedPathBacktick(bodyLine));
      }
      continue;
    }

    // Real code fence. Always emit a closing ``` so an unclosed open fence
    // from the model still forms a complete region for the block parser.
    out.push(openLine);
    out.push(...bodyLines);
    out.push('```');
  }

  return out.join('\n');
}
