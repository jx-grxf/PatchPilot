import { afterEach, describe, expect, it, vi } from "vitest";
import { readLines } from "../src/core/stream.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("stream cancellation", () => {
  it("cancels a blocked body read when the parent aborts", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const controller = new AbortController();
    const next = readLines(response, controller.signal).next();

    controller.abort();

    await expect(next).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("fails and cancels when a response body stays idle", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const next = readLines(response, undefined, 25).next();
    const rejection = expect(next).rejects.toThrow("idle for 25 ms");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
