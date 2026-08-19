export interface FileReadLineRange {
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface FileReadSlice {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly ranged: boolean;
}

export class FileReadRangeError extends Error {
  readonly code: 'invalid_line_range' | 'start_line_out_of_range';

  constructor(code: FileReadRangeError['code'], message: string) {
    super(message);
    this.name = 'FileReadRangeError';
    this.code = code;
  }
}

function asPositiveInt(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new FileReadRangeError('invalid_line_range', `${key} must be a 1-based integer`);
  }
  return numeric;
}

export function splitFileLines(content: string): readonly string[] {
  if (content === '') return [];
  const lines = content.split(/\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

export function formatNumberedLines(lines: readonly string[], startLine: number): string {
  if (lines.length === 0) return '';
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

export function parseFileReadLineRange(input: Readonly<Record<string, unknown>>): FileReadLineRange {
  const startLine = asPositiveInt(input.start_line, 'start_line');
  const endLine = asPositiveInt(input.end_line, 'end_line');
  if (startLine != null && endLine != null && startLine > endLine) {
    throw new FileReadRangeError('invalid_line_range', 'start_line must be <= end_line');
  }
  return {
    ...(startLine != null ? { startLine } : {}),
    ...(endLine != null ? { endLine } : {}),
  };
}

export function sliceFileReadLines(content: string, range: FileReadLineRange = {}): FileReadSlice {
  const lines = splitFileLines(content);
  const totalLines = lines.length;
  const ranged = range.startLine != null || range.endLine != null;
  if (!ranged) {
    return {
      content,
      startLine: totalLines === 0 ? 0 : 1,
      endLine: totalLines,
      totalLines,
      ranged: false,
    };
  }

  const startLine = range.startLine ?? 1;
  if (totalLines === 0) {
    if (startLine > 1) {
      throw new FileReadRangeError('start_line_out_of_range', 'start_line is past the end of the file');
    }
    return {
      content: '',
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      ranged: true,
    };
  }
  if (startLine > totalLines) {
    throw new FileReadRangeError('start_line_out_of_range', 'start_line is past the end of the file');
  }
  const endLine = Math.min(range.endLine ?? totalLines, totalLines);
  const slice = lines.slice(startLine - 1, endLine);
  return {
    content: formatNumberedLines(slice, startLine),
    startLine,
    endLine,
    totalLines,
    ranged: true,
  };
}
