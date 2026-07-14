export type B3Cell = 0 | 1 | 2;
export type B3ColorRole = 'primary' | 'signal' | 'muted';
export type B3TerminalVariant = 'full' | 'half' | 'narrow';

export interface B3TerminalSegment {
  readonly text: string;
  readonly fg?: B3ColorRole;
  readonly bg?: B3ColorRole;
}

export interface B3TerminalLine {
  readonly segments: readonly B3TerminalSegment[];
  readonly plain: string;
}

export interface B3RenderedWordmark {
  readonly id: B3TerminalVariant;
  readonly label: string;
  readonly description: string;
  readonly width: number;
  readonly height: number;
  readonly lines: readonly B3TerminalLine[];
}

export interface B3PreviewManifest {
  readonly name: 'Peer Agent';
  readonly direction: 'B3 · Signal';
  readonly colors: typeof B3_WORDMARK_COLORS;
  readonly matrix: {
    readonly width: number;
    readonly height: number;
    readonly rows: readonly string[];
    readonly legend: Readonly<Record<'.' | '#' | '=', string>>;
    readonly signalRow: number;
    readonly signalColumns: readonly [number, number];
  };
  readonly variants: Readonly<Record<B3TerminalVariant, B3RenderedWordmark>>;
}

const GLYPHS = {
  p: [
    '00000',
    '11110',
    '10001',
    '10001',
    '11110',
    '10000',
    '10000',
  ],
  e: [
    '00000',
    '01110',
    '10001',
    '11111',
    '10000',
    '01110',
    '00000',
  ],
  r: [
    '00000',
    '10110',
    '11001',
    '10000',
    '10000',
    '10000',
    '00000',
  ],
} as const;

export const B3_WORDMARK_COLORS = {
  primary: '#e8e6e0',
  signal: '#7189c9',
  muted: '#777a83',
} as const satisfies Readonly<Record<B3ColorRole, string>>;

export const B3_SIGNAL_ROW = 3;
export const B3_SIGNAL_COLUMNS = [6, 16] as const;
export const B3_AGENT_ROW = 5;

function composeB3Matrix(): readonly (readonly B3Cell[])[] {
  const letters = ['p', 'e', 'e', 'r'] as const;
  const rows: B3Cell[][] = Array.from({ length: 7 }, () => []);

  for (const [letterIndex, letter] of letters.entries()) {
    const glyph = GLYPHS[letter];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const glyphRow = glyph[rowIndex];
      if (!row || glyphRow === undefined) {
        throw new Error(`Invalid B3 glyph row ${rowIndex} for ${letter}`);
      }
      row.push(...[...glyphRow].map((cell): B3Cell => cell === '1' ? 1 : 0));
      if (letterIndex < letters.length - 1) {
        row.push(0);
      }
    }
  }

  const signalRow = rows[B3_SIGNAL_ROW];
  if (!signalRow) {
    throw new Error('B3 signal row is missing');
  }
  for (let column = B3_SIGNAL_COLUMNS[0]; column <= B3_SIGNAL_COLUMNS[1]; column += 1) {
    signalRow[column] = 2;
  }

  return rows;
}

export const B3_PIXEL_MATRIX = composeB3Matrix();
export const B3_MATRIX_HEIGHT = B3_PIXEL_MATRIX.length;
export const B3_MATRIX_WIDTH = B3_PIXEL_MATRIX[0]?.length ?? 0;

function cellRole(cell: B3Cell): B3ColorRole | undefined {
  if (cell === 2) {
    return 'signal';
  }
  if (cell === 1) {
    return 'primary';
  }
  return undefined;
}

function appendSegment(
  segments: B3TerminalSegment[],
  text: string,
  fg?: B3ColorRole,
  bg?: B3ColorRole,
): void {
  if (!text) {
    return;
  }
  const previous = segments.at(-1);
  if (previous && previous.fg === fg && previous.bg === bg) {
    segments[segments.length - 1] = { text: previous.text + text, fg, bg };
    return;
  }
  segments.push({ text, fg, bg });
}

function finishLine(segments: readonly B3TerminalSegment[]): B3TerminalLine {
  return {
    segments,
    plain: segments.map((segment) => segment.text).join(''),
  };
}

function appendAgentSuffix(
  segments: B3TerminalSegment[],
  rowIndex: number,
  agentRow: number,
): void {
  appendSegment(segments, '  ');
  appendSegment(segments, rowIndex === agentRow ? 'agent' : '     ', rowIndex === agentRow ? 'muted' : undefined);
}

function renderFullBlock(): B3RenderedWordmark {
  const lines = B3_PIXEL_MATRIX.map((row, rowIndex) => {
    const segments: B3TerminalSegment[] = [];
    for (const cell of row) {
      appendSegment(segments, cell === 0 ? '  ' : '██', cellRole(cell));
    }
    appendAgentSuffix(segments, rowIndex, B3_AGENT_ROW);
    return finishLine(segments);
  });

  return {
    id: 'full',
    label: 'Full Block',
    description: '7 行高，逻辑像素使用两个全块字符，轮廓最接近 B3 网页稿。',
    width: lines[0]?.plain.length ?? 0,
    height: lines.length,
    lines,
  };
}

function halfBlockCell(top: B3Cell, bottom: B3Cell): B3TerminalSegment {
  const topRole = cellRole(top);
  const bottomRole = cellRole(bottom);

  if (!topRole && !bottomRole) {
    return { text: ' ' };
  }
  if (topRole && bottomRole) {
    if (topRole === bottomRole) {
      return { text: '█', fg: topRole };
    }
    return { text: '▀', fg: topRole, bg: bottomRole };
  }
  if (topRole) {
    return { text: '▀', fg: topRole };
  }
  return { text: '▄', fg: bottomRole };
}

function renderHalfBlock(): B3RenderedWordmark {
  const lines: B3TerminalLine[] = [];
  const halfHeight = Math.ceil(B3_MATRIX_HEIGHT / 2);
  const halfAgentRow = 2;

  for (let halfRow = 0; halfRow < halfHeight; halfRow += 1) {
    const top = B3_PIXEL_MATRIX[halfRow * 2] ?? Array.from({ length: B3_MATRIX_WIDTH }, (): B3Cell => 0);
    const bottom = B3_PIXEL_MATRIX[(halfRow * 2) + 1] ?? Array.from({ length: B3_MATRIX_WIDTH }, (): B3Cell => 0);
    const segments: B3TerminalSegment[] = [];
    for (let column = 0; column < B3_MATRIX_WIDTH; column += 1) {
      const packed = halfBlockCell(top[column] ?? 0, bottom[column] ?? 0);
      appendSegment(segments, packed.text, packed.fg, packed.bg);
    }
    appendAgentSuffix(segments, halfRow, halfAgentRow);
    lines.push(finishLine(segments));
  }

  return {
    id: 'half',
    label: 'Half Block',
    description: '用 ▀ / ▄ / █ 将两行逻辑像素压进一行终端字符，保留蓝色信号桥。',
    width: lines[0]?.plain.length ?? 0,
    height: lines.length,
    lines,
  };
}

function renderNarrowFallback(): B3RenderedWordmark {
  const line = finishLine([
    { text: 'peer', fg: 'primary' },
    { text: '━', fg: 'signal' },
    { text: 'agent', fg: 'muted' },
  ]);

  return {
    id: 'narrow',
    label: 'Narrow Fallback',
    description: '终端不足以容纳大字时主动降级，不挤压矩阵；蓝色横线继续表达连接。',
    width: line.plain.length,
    height: 1,
    lines: [line],
  };
}

const RENDERED_VARIANTS: Readonly<Record<B3TerminalVariant, B3RenderedWordmark>> = {
  full: renderFullBlock(),
  half: renderHalfBlock(),
  narrow: renderNarrowFallback(),
};

export function renderB3Wordmark(variant: B3TerminalVariant): B3RenderedWordmark {
  return RENDERED_VARIANTS[variant];
}

export function matrixRowsForPreview(): readonly string[] {
  return B3_PIXEL_MATRIX.map((row) => row.map((cell) => cell === 2 ? '=' : cell === 1 ? '#' : '.').join(''));
}

export function createB3PreviewManifest(): B3PreviewManifest {
  return {
    name: 'Peer Agent',
    direction: 'B3 · Signal',
    colors: B3_WORDMARK_COLORS,
    matrix: {
      width: B3_MATRIX_WIDTH,
      height: B3_MATRIX_HEIGHT,
      rows: matrixRowsForPreview(),
      legend: {
        '.': 'empty',
        '#': 'primary',
        '=': 'signal',
      },
      signalRow: B3_SIGNAL_ROW,
      signalColumns: B3_SIGNAL_COLUMNS,
    },
    variants: RENDERED_VARIANTS,
  };
}
