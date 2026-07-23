export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function sanitizeText(value: unknown, maxLength = 1000): string {
  if (typeof value !== 'string') return '';
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function readLimited(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (bytes < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limitBytes - bytes;
      const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
      bytes += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
      if (value.byteLength > remaining || bytes >= limitBytes) break;
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface SseOptions {
  signal?: AbortSignal;
  maxEventBytes: number;
  createError?: (reason: 'empty_body' | 'aborted' | 'event_too_large') => Error;
}

export async function* readSseData(response: Response, options: SseOptions): AsyncGenerator<string> {
  const error = (reason: 'empty_body' | 'aborted' | 'event_too_large'): Error =>
    options.createError?.(reason) ?? new Error(reason);
  if (!response.body) throw error('empty_body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const parseBlock = (block: string): string => {
    if (byteLength(block) > options.maxEventBytes) throw error('event_too_large');
    return block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
  };

  try {
    for (;;) {
      if (options.signal?.aborted) throw error('aborted');
      const { done, value } = await reader.read();
      if (options.signal?.aborted) throw error('aborted');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.match(/\r?\n\r?\n/);
        if (!boundary || boundary.index === undefined) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = parseBlock(block);
        if (data) yield data;
      }
      if (byteLength(buffer) > options.maxEventBytes) throw error('event_too_large');
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = parseBlock(buffer);
      if (data) yield data;
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
  }
}

export interface RequestSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

export function createRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage = 'request timed out',
): RequestSignal {
  const controller = new AbortController();
  let didTimeOut = false;
  const onAbort = (): void => {
    controller.abort(callerSignal?.reason ?? new Error('request aborted'));
  };
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}
