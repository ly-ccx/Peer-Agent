/** UTF-16 source positions carried through display-only normalization. */
export interface MarkdownSourceText {
  readonly text: string;
  readonly offsets: readonly number[];
}

export function normalizeMarkdownSource(source: string): MarkdownSourceText {
  let text = '';
  const offsets: number[] = [];
  const comments = /<!--[\s\S]*?-->/g;
  let comment = comments.exec(source);
  for (let i = 0; i < source.length; i += 1) {
    if (comment && i === comment.index) {
      i += comment[0].length - 1;
      comment = comments.exec(source);
      continue;
    }
    offsets.push(i);
    if (source[i] === '\r') {
      text += '\n';
      if (source[i + 1] === '\n') i += 1;
    } else text += source[i];
  }
  offsets.push(source.length);
  return { text, offsets };
}

export function sourceLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
