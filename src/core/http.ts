import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  options: {
    timeoutMs: number;
    retries?: number;
    retryDelayMs?: number;
    label: string;
  }
): Promise<Response> {
  const attempts = Math.max(1, (options.retries ?? 0) + 1);
  let lastError: unknown = null;
  let lastStatus = 0;
  let attempted = 0;
  const parentSignal = init.signal ?? undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    attempted = attempt;
    try {
      const response = await fetchOnceWithTimeout(input, init, options.timeoutMs);
      if (!isRetryableStatus(response.status) || attempt >= attempts || parentSignal?.aborted) {
        return response;
      }

      lastStatus = response.status;
      await discardResponseBody(response);
      await delay(readRetryDelayMs(response, attempt, options.retryDelayMs), parentSignal);
      if (parentSignal?.aborted) {
        break;
      }
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || parentSignal?.aborted) {
        break;
      }

      await delay(readRetryDelayMs(null, attempt, options.retryDelayMs), parentSignal);
      if (parentSignal?.aborted) {
        break;
      }
    }
  }

  const statusSuffix = lastStatus > 0 ? ` Last HTTP status: ${lastStatus}.` : "";
  const suffix = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`${options.label} timed out or could not be reached after ${attempted} attempt${attempted === 1 ? "" : "s"}.${statusSuffix}${suffix}`);
}

async function fetchOnceWithTimeout(input: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = (): void => controller.abort();

  if (init.signal?.aborted) {
    controller.abort();
  } else {
    init.signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromParent);
  }
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const abort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup before retrying; the next attempt should still run.
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function readRetryDelayMs(response: Response | null, attempt: number, configuredDelayMs: number | undefined): number {
  const retryAfterMs = readRetryAfterMs(response?.headers.get("retry-after") ?? null);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const baseDelayMs = configuredDelayMs ?? 150;
  const exponentialDelayMs = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitterMs = Math.floor(Math.random() * Math.min(250, baseDelayMs));
  return Math.min(5000, exponentialDelayMs + jitterMs);
}

function readRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const numericSeconds = Number.parseFloat(value);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.min(30_000, numericSeconds * 1000);
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.min(30_000, Math.max(0, timestamp - Date.now()));
  }

  return null;
}

/**
 * POST for model calls. Node's fetch (undici) drops a response once 300 s pass
 * without a byte, before or after the headers, and a local server writing a
 * large tool call sends nothing for longer than that. `node:http` has no such
 * timeout, so the idle timer in `stream.ts` stays the only judge of a stalled
 * server, and esc stays the way to stop a slow one.
 */
export async function postToModel(
  url: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal; connectTimeoutMs?: number }
): Promise<Response> {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;

  return await new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: "POST",
        headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) },
        signal: init.signal
      },
      (response) => {
        clearTimeout(connectTimer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            headers.append(name, entry);
          }
        }
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage,
            headers
          })
        );
      }
    );

    // Only the connection is timed: once the server has accepted the request,
    // prompt evaluation may legitimately take minutes before the first byte.
    const connectTimer = setTimeout(() => {
      request.destroy(new Error(`could not be reached within ${init.connectTimeoutMs ?? 5000} ms`));
    }, init.connectTimeoutMs ?? 5000);
    request.on("socket", (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
        return;
      }
      socket.once("connect", () => clearTimeout(connectTimer));
    });
    request.on("error", (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    request.end(init.body);
  });
}
