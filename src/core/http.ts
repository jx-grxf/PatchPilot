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

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchOnceWithTimeout(input, init, options.timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || init.signal?.aborted) {
        break;
      }

      await delay(options.retryDelayMs ?? 150);
    }
  }

  const suffix = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`${options.label} timed out or could not be reached after ${attempts} attempt${attempts === 1 ? "" : "s"}.${suffix}`);
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

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
