import { describe, expect, it, vi } from "vitest";
import { RobloxApiError } from "../api/http";
import { runPaced } from "./queue";

const noSleep = vi.fn(async () => {});

describe("runPaced", () => {
  it("runs tasks in order with a pause between each", async () => {
    const seen: number[] = [];
    const sleep = vi.fn(async () => {});

    const results = await runPaced([1, 2, 3], async (n) => void seen.push(n), { intervalMs: 500, sleep });

    expect(seen).toEqual([1, 2, 3]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(sleep.mock.calls).toEqual([[500], [500]]);
  });

  it("records a failure and keeps going", async () => {
    const results = await runPaced(
      [1, 2],
      async (n) => {
        if (n === 1) throw new RobloxApiError("The price is too low", 400);
      },
      { sleep: noSleep },
    );

    expect(results).toEqual([
      { task: 1, ok: false, error: "The price is too low" },
      { task: 2, ok: true },
    ]);
  });

  it("retries rate-limited requests, honoring retry-after", async () => {
    const sleep = vi.fn(async () => {});
    const worker = vi
      .fn()
      .mockRejectedValueOnce(new RobloxApiError("Too many requests", 429, 3000))
      .mockResolvedValueOnce(undefined);

    const results = await runPaced(["a"], worker, { sleep });

    expect(results[0].ok).toBe(true);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("gives up after maxRetries rate limits", async () => {
    const worker = vi.fn().mockRejectedValue(new RobloxApiError("Too many requests", 429));

    const results = await runPaced(["a"], worker, { maxRetries: 2, sleep: noSleep });

    expect(results[0]).toMatchObject({ ok: false, error: "Too many requests" });
    expect(worker).toHaveBeenCalledTimes(3);
  });

  it("stops when aborted and reports progress", async () => {
    const controller = new AbortController();
    const progress: number[] = [];

    const results = await runPaced(
      [1, 2, 3],
      async (n) => {
        if (n === 2) controller.abort();
      },
      { signal: controller.signal, sleep: noSleep, onResult: (_r, done) => progress.push(done) },
    );

    expect(results.map((r) => r.task)).toEqual([1, 2]);
    expect(progress).toEqual([1, 2]);
  });
});
