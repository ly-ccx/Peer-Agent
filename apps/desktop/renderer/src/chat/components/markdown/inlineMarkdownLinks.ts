export type MarkdownLinkToken = {
  start: number;
  end: number;
  label: string;
  destination: string;
};

export type MarkdownImageToken = {
  start: number;
  end: number;
  alt: string;
  destination: string;
};

function findClosingBracket(text: string, openingIndex: number): number {
  let depth = 0;
  let codeFenceLength = 0;

  for (let index = openingIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '`') {
      let runEnd = index + 1;
      while (text[runEnd] === '`') runEnd += 1;
      const runLength = runEnd - index;
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (runLength === codeFenceLength) codeFenceLength = 0;
      index = runEnd - 1;
      continue;
    }
    if (codeFenceLength > 0) continue;
    if (char === '[') depth += 1;
    if (char === ']' && depth === 0) return index;
    if (char === ']') depth -= 1;
  }

  return -1;
}

function readDestination(text: string, openingIndex: number) {
  let index = openingIndex + 1;
  while (index < text.length && /[ \t]/.test(text[index])) index += 1;

  if (text[index] === '<') {
    const destinationStart = index + 1;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '>') {
        const destination = text.slice(destinationStart, index);
        index += 1;
        while (index < text.length && /[ \t]/.test(text[index])) index += 1;
        return text[index] === ')' ? { destination, end: index + 1 } : null;
      }
      if (text[index] === '\n') return null;
      index += 1;
    }
    return null;
  }

  const destinationStart = index;
  let depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) {
        return {
          destination: text.slice(destinationStart, index).trim(),
          end: index + 1,
        };
      }
      depth -= 1;
    }
    if (char === '\n') return null;
    index += 1;
  }
  return null;
}

/** Finds the next inline Markdown link without letting formatting inside its label win token priority. */
export function findMarkdownLink(text: string, from = 0): MarkdownLinkToken | null {
  let openingIndex = text.indexOf('[', from);
  while (openingIndex >= 0) {
    if (openingIndex > 0 && text[openingIndex - 1] === '!' && text[openingIndex - 2] !== '\\') {
      openingIndex = text.indexOf('[', openingIndex + 1);
      continue;
    }

    const closingIndex = findClosingBracket(text, openingIndex);
    if (closingIndex < 0) return null;
    let destinationOpening = closingIndex + 1;
    while (destinationOpening < text.length && /[ \t]/.test(text[destinationOpening])) {
      destinationOpening += 1;
    }
    if (text[destinationOpening] !== '(') {
      openingIndex = text.indexOf('[', openingIndex + 1);
      continue;
    }

    const parsedDestination = readDestination(text, destinationOpening);
    if (!parsedDestination || !parsedDestination.destination) {
      openingIndex = text.indexOf('[', openingIndex + 1);
      continue;
    }

    return {
      start: openingIndex,
      end: parsedDestination.end,
      label: text.slice(openingIndex + 1, closingIndex),
      destination: parsedDestination.destination.replace(/\\([\\`()\[\]])/g, '$1'),
    };
  }

  return null;
}

export function findMarkdownImage(text: string, fromIndex = 0): MarkdownImageToken | null {
  let bangIndex = text.indexOf('![', fromIndex);

  while (bangIndex >= 0) {
    if (bangIndex > 0 && text[bangIndex - 1] === '\\') {
      bangIndex = text.indexOf('![', bangIndex + 2);
      continue;
    }

    const openingIndex = bangIndex + 1;
    const closingIndex = findClosingBracket(text, openingIndex);
    if (closingIndex < 0) {
      bangIndex = text.indexOf('![', bangIndex + 2);
      continue;
    }

    let destinationOpening = closingIndex + 1;
    while (destinationOpening < text.length && /[ \t]/.test(text[destinationOpening])) {
      destinationOpening += 1;
    }
    if (text[destinationOpening] !== '(') {
      bangIndex = text.indexOf('![', bangIndex + 2);
      continue;
    }

    const parsedDestination = readDestination(text, destinationOpening);
    if (parsedDestination && parsedDestination.destination) {
      return {
        start: bangIndex,
        end: parsedDestination.end,
        alt: text.slice(openingIndex + 1, closingIndex),
        destination: parsedDestination.destination.replace(/\\([\\`()\[\]])/g, '$1'),
      };
    }

    bangIndex = text.indexOf('![', bangIndex + 2);
  }

  return null;
}

export function safeExternalHref(destination: string): string | null {
  return /^(https?:|mailto:)/i.test(destination) ? destination : null;
}
