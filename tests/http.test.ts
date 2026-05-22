import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../src/core/http.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
  it("cancels retryable response bodies before the next attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const retryResponse = new Response("retry", { status: 503 });
    const cancelSpy = vi.spyOn(retryResponse.body!, "cancel");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchWithTimeout(
      "https://provider.test/chat",
      {},
      {
        timeoutMs: 1000,
        retries: 1,
        retryDelayMs: 1,
        label: "provider chat"
      }
    );

    expect(response.status).toBe(200);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops waiting for retry-after when the parent signal is aborted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("retry", {
        status: 503,
        headers: {
          "retry-after": "30"
        }
      })
    );
    const controller = new AbortController();

    const request = fetchWithTimeout(
      "https://provider.test/chat",
      {
        signal: controller.signal
      },
      {
        timeoutMs: 1000,
        retries: 1,
        label: "provider chat"
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toThrow("after 1 attempt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
