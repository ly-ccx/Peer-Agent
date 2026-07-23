const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_CONTENT_CHARS = 2_000_000;

export interface NodeWebFetchResult {
  readonly ok: boolean;
  readonly finalUrl?: string;
  readonly title?: string;
  readonly content?: string;
  readonly contentType?: string;
  readonly httpStatus?: number;
  readonly fetchMode: 'http' | 'failed';
  readonly error?: string;
}

export interface FetchLikeResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body?: ReadableStream<Uint8Array> | null;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export type NodeFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<FetchLikeResponse>;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<\/div\s*>/gi, '\n')
      .replace(/<\/li\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]!.replace(/\s+/g, ' ').trim()) : '';
}

export function normalizeWebUrl(value: unknown, base?: URL): URL {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid_url');
  let parsed: URL;
  try {
    parsed = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new Error('invalid_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('unsupported_protocol');
  }
  return parsed;
}

function normalizeTimeout(value: unknown): number {
  const timeout = typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, timeout));
}

async function readResponseBody(response: FetchLikeResponse): Promise<string> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
    return buffer.toString('utf8');
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel('response_too_large');
        throw new Error('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeContent(raw: string, contentType: string): { title: string; content: string } {
  const isHtml = contentType.includes('text/html') || /<html|<body|<title/i.test(raw);
  const title = isHtml ? extractTitle(raw) : '';
  const content = (isHtml ? stripHtml(raw) : raw).slice(0, MAX_CONTENT_CHARS);
  return { title, content };
}

export async function fetchNodeWebPage(options: {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetcher?: NodeFetchLike;
}): Promise<NodeWebFetchResult> {
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as NodeFetchLike);
  if (typeof fetcher !== 'function') {
    return { ok: false, fetchMode: 'failed', error: 'fetch_unavailable' };
  }

  const controller = new AbortController();
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error('aborted'));
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let currentUrl = normalizeWebUrl(options.url);
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetcher(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Peer-Agent/1.0 (+local.web.fetch)',
          accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect_without_location');
        if (redirectCount >= MAX_REDIRECTS) throw new Error('too_many_redirects');
        currentUrl = normalizeWebUrl(location, currentUrl);
        continue;
      }
      if (!response.ok) {
        return {
          ok: false,
          finalUrl: currentUrl.toString(),
          httpStatus: response.status,
          fetchMode: 'failed',
          error: `http_${response.status}`,
        };
      }
      const contentType = response.headers.get('content-type') ?? 'text/plain';
      const raw = await readResponseBody(response);
      const normalized = normalizeContent(raw, contentType.toLocaleLowerCase());
      return {
        ok: true,
        finalUrl: currentUrl.toString(),
        title: normalized.title,
        content: normalized.content,
        contentType,
        httpStatus: response.status,
        fetchMode: 'http',
      };
    }
    return { ok: false, fetchMode: 'failed', error: 'too_many_redirects' };
  } catch (error) {
    const reason = controller.signal.aborted
      ? (options.signal?.aborted ? 'aborted' : 'timeout')
      : error instanceof Error ? error.message : String(error);
    return { ok: false, fetchMode: 'failed', error: reason };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
