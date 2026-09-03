/**
 * Line-oriented reading for streaming chat responses.
 *
 * Ollama streams newline-delimited JSON; OpenAI-compatible servers stream
 * Server-Sent Events, which are newline-delimited too once the `data: ` prefix
 * is stripped. Both are handled here so the provider clients only deal in
 * parsed payloads.
 */

/** Yields complete lines from a response body, tolerating chunk boundaries. */
export async function* readLines(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
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

      const { done, value } = await reader.read();
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
    // Releasing the lock lets an aborted request tear the socket down instead
    // of leaving the body half-read.
    reader.releaseLock();
  }
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
