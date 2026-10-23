import { RobloxApiError } from "../api/http";

// Roblox has no bulk-update endpoint, so saves go out one at a time with a
// pause between them. Rate-limit responses (429) are retried with backoff;
// any other failure is reported for that task and the queue moves on.

export interface TaskResult<T> {
  task: T;
  ok: boolean;
  error?: string;
}

export interface QueueOptions<T> {
  intervalMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  onResult?: (result: TaskResult<T>, done: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runPaced<T>(
  tasks: T[],
  worker: (task: T) => Promise<void>,
  { intervalMs = 750, maxRetries = 4, signal, onResult, sleep = defaultSleep }: QueueOptions<T> = {},
): Promise<TaskResult<T>[]> {
  const results: TaskResult<T>[] = [];
  for (const [i, task] of tasks.entries()) {
    if (signal?.aborted) break;
    if (i > 0) await sleep(intervalMs);

    let result: TaskResult<T> | undefined;
    for (let attempt = 0; !result; attempt++) {
      try {
        await worker(task);
        result = { task, ok: true };
      } catch (e) {
        const rateLimited = e instanceof RobloxApiError && e.status === 429;
        if (rateLimited && attempt < maxRetries && !signal?.aborted) {
          await sleep(e.retryAfterMs ?? 2000 * 2 ** attempt);
          continue;
        }
        result = { task, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    results.push(result);
    onResult?.(result, results.length, tasks.length);
  }
  return results;
}
