import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, postToModel } from "../src/core/http.js";

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

describe("postToModel", () => {
  it("streams a body that arrives after a pause, as a web Response", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write("data: first\n\n");
        setTimeout(() => response.end(`data: ${body}\n\n`), 50);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const response = await postToModel(`http://127.0.0.1:${port}/v1/chat/completions`, {
        headers: { "Content-Type": "application/json" },
        body: '{"ok":true}'
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.text()).toBe('data: first\n\ndata: {"ok":true}\n\n');
    } finally {
      server.close();
    }
  });

  it("rejects when nothing listens", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(postToModel(`http://127.0.0.1:${port}/v1/chat/completions`, { headers: {}, body: "{}" })).rejects.toThrow();
  });
});
