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
    const rejection = expect(next).rejects.toThrow("sent nothing for 25 ms");

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("re-reads a dynamic idle timeout before every chunk", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }));
    let timeoutMs = 25;
    const lines = readLines(response, undefined, () => timeoutMs);

    controller.enqueue(encoder.encode("header\n"));
    await expect(lines.next()).resolves.toEqual({ done: false, value: "header" });

    timeoutMs = 1000;
    const next = lines.next();
    await vi.advanceTimersByTimeAsync(500);
    controller.enqueue(encoder.encode("arguments\n"));
    await expect(next).resolves.toEqual({ done: false, value: "arguments" });
  });
});
