import type { ChatStreamEvent } from '@zeus-atlas/protocol';

export interface SseParserState {
  readonly buffer: string;
  readonly eventName: string;
  readonly eventId?: string;
  readonly retry?: number;
  readonly dataLines: readonly string[];
}

export interface SseParseResult {
  readonly state: SseParserState;
  readonly events: readonly ChatStreamEvent[];
}

export function createSseParserState(): SseParserState {
  return {
    buffer: '',
    eventName: '',
    dataLines: [],
  };
}

function parseEventData(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === '[DONE]') return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function dispatchEvent(state: SseParserState): ChatStreamEvent | null {
  if (state.dataLines.length === 0) return null;

  const rawData = state.dataLines.join('\n');
  return {
    event: state.eventName || 'message',
    data: parseEventData(rawData),
    ...(state.eventId ? { id: state.eventId } : {}),
    ...(typeof state.retry === 'number' ? { retry: state.retry } : {}),
  };
}

function resetEventFrame(state: SseParserState): SseParserState {
  return {
    buffer: state.buffer,
    eventName: '',
    dataLines: [],
  };
}

function applyLine(state: SseParserState, line: string): {
  readonly state: SseParserState;
  readonly event: ChatStreamEvent | null;
} {
  if (line === '') {
    return {
      state: resetEventFrame(state),
      event: dispatchEvent(state),
    };
  }

  if (line.startsWith(':')) {
    return { state, event: null };
  }

  const separator = line.indexOf(':');
  const field = separator >= 0 ? line.slice(0, separator) : line;
  const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';

  if (field === 'event') {
    return { state: { ...state, eventName: value }, event: null };
  }

  if (field === 'id') {
    return { state: { ...state, eventId: value }, event: null };
  }

  if (field === 'retry') {
    const retry = Number(value);
    return {
      state: Number.isFinite(retry) ? { ...state, retry } : state,
      event: null,
    };
  }

  if (field === 'data') {
    return {
      state: { ...state, dataLines: [...state.dataLines, value] },
      event: null,
    };
  }

  return { state, event: null };
}

export function parseSseChunk(state: SseParserState, chunk: string): SseParseResult {
  const text = state.buffer + chunk;
  const lines = text.split(/\r?\n/);
  const nextBuffer = lines.pop() ?? '';
  let nextState: SseParserState = { ...state, buffer: nextBuffer };
  const events: ChatStreamEvent[] = [];

  for (const line of lines) {
    const result = applyLine(nextState, line);
    nextState = result.state;
    if (result.event) {
      events.push(result.event);
    }
  }

  return { state: nextState, events };
}

export function flushSseParser(state: SseParserState): SseParseResult {
  let nextState = state;
  const events: ChatStreamEvent[] = [];

  if (state.buffer) {
    const result = applyLine({ ...state, buffer: '' }, state.buffer);
    nextState = result.state;
    if (result.event) events.push(result.event);
  }

  const pending = dispatchEvent(nextState);
  if (pending) {
    events.push(pending);
    nextState = resetEventFrame({ ...nextState, buffer: '' });
  }

  return { state: nextState, events };
}

export interface StreamDelta {
  readonly type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error';
  readonly payload: unknown;
}

export function parseServerSentEventLine(line: string): StreamDelta | null {
  if (!line.startsWith('data:')) return null;
  const data = parseEventData(line.slice('data:'.length));
  if (data === null) return { type: 'done', payload: null };
  if (typeof data === 'object' && data && 'type' in data && 'payload' in data) {
    return data as StreamDelta;
  }
  return { type: 'content', payload: data };
}
