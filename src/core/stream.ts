/**
 * Line-oriented reading for streaming chat responses.
 *
 * Ollama streams newline-delimited JSON; OpenAI-compatible servers stream
 * Server-Sent Events, which are newline-delimited too once the `data: ` prefix
 * is stripped. Both are handled here so the provider clients only deal in
 * parsed payloads.
 */

const defaultStreamIdleTimeoutMs = 120_000;

/** Yields complete lines from a response body, tolerating chunk boundaries. */
export async function* readLines(response: Response, signal?: AbortSignal, idleTimeoutMs = defaultStreamIdleTimeoutMs): AsyncGenerator<string> {
  const body = response.body;
  if (!body) {
    throw new Error("Streaming response had no body.");
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }

      const { done, value } = await readNextChunk(reader, signal, idleTimeoutMs);
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          yield line;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail) {
      yield tail;
    }
  } finally {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/** Read at most maxBytes from a response and cancel the body once the cap is reached. */
export async function readTextLimited(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  idleTimeoutMs = defaultStreamIdleTimeoutMs
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    return { text: "", bytes: 0, truncated: false };
  }

  const byteLimit = Math.max(1, Math.trunc(maxBytes));
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  let bytes = 0;

  try {
    while (bytes < byteLimit) {
      const { done, value } = await readNextChunk(reader, signal, idleTimeoutMs);
      if (signal?.aborted) {
        throw new Error("Response body read was aborted.");
      }
      if (done) {
        text += decoder.decode();
        return { text, bytes, truncated: false };
      }

      const remaining = byteLimit - bytes;
      const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytes += accepted.byteLength;
      text += decoder.decode(accepted, { stream: true });
      if (value.byteLength > remaining || bytes >= byteLimit) {
        text += decoder.decode();
        await reader.cancel().catch(() => undefined);
        return { text, bytes, truncated: true };
      }
    }

    return { text, bytes, truncated: true };
  } finally {
    reader.releaseLock();
  }
}

async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      void reader.cancel().catch(() => undefined);
      finish(() => resolve({ done: true, value: undefined }));
    };
    const timeout = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      finish(() => reject(new Error(`Streaming response was idle for ${idleTimeoutMs} ms.`)));
    }, idleTimeoutMs);

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

/**
 * Yields parsed SSE data payloads, skipping comments, event/id fields, and the
 * terminal `[DONE]` sentinel. Malformed frames are skipped rather than thrown:
 * a single bad chunk should not lose an otherwise good response.
 */
export async function* readServerSentJson(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  for await (const line of readLines(response, signal)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    const parsed = tryParseJson(payload);
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

/** Yields parsed newline-delimited JSON objects. */
export async function* readNewlineDelimitedJson(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  for await (const line of readLines(response, signal)) {
    const parsed = tryParseJson(line);
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Tracks streaming timings so throughput can be reported while a response is
 * still arriving. Time-to-first-token is measured separately from total
 * duration because on local hardware the two diverge sharply: prompt
 * evaluation dominates TTFT, generation dominates the rest.
 */
export class StreamTimer {
  private readonly startedAt = Date.now();
  private firstTokenAt: number | null = null;

  markFirstToken(): void {
    if (this.firstTokenAt === null) {
      this.firstTokenAt = Date.now();
    }
  }

  get timeToFirstTokenMs(): number | null {
    return this.firstTokenAt === null ? null : this.firstTokenAt - this.startedAt;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Milliseconds spent generating, i.e. excluding prompt evaluation. */
  get generationMs(): number {
    return this.firstTokenAt === null ? 0 : Date.now() - this.firstTokenAt;
  }
}
