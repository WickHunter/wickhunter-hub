import { gzip } from "node:zlib";

export type GzipCallback = (error: Error | null, result?: Buffer) => void;
export type GzipFunction = (input: Buffer, callback: GzipCallback) => void;

export interface AsyncGzipLimits {
  maxActive: number;
  maxJobs: number;
  maxRetainedBytes: number;
}

export const DEFAULT_ASYNC_GZIP_LIMITS: Readonly<AsyncGzipLimits> = {
  maxActive: 2,
  maxJobs: 8,
  maxRetainedBytes: 64 * 1024 * 1024,
};

export class GzipCapacityError extends Error {
  constructor(message = "response compression is busy") {
    super(message);
    this.name = "GzipCapacityError";
  }
}

interface PendingJob {
  input: Buffer;
  resolve: (value: Buffer) => void;
  reject: (reason: Error) => void;
}

export interface GzipReservation {
  compress(input: Buffer): Promise<Buffer>;
  release(): void;
}

/**
 * Bounded admission and execution for large response compression. A reservation
 * counts against maxJobs before a caller builds its response body; the exact
 * byte limit is enforced when that body is submitted.
 */
export class AsyncGzipQueue {
  private active = 0;
  private jobs = 0;
  private retainedBytes = 0;
  private readonly pending: PendingJob[] = [];
  private readonly limits: AsyncGzipLimits;
  private readonly gzipFn: GzipFunction;

  constructor(options: Partial<AsyncGzipLimits> & { gzip?: GzipFunction } = {}) {
    this.limits = { ...DEFAULT_ASYNC_GZIP_LIMITS, ...options };
    if (!Number.isSafeInteger(this.limits.maxActive) || this.limits.maxActive < 1
      || !Number.isSafeInteger(this.limits.maxJobs) || this.limits.maxJobs < this.limits.maxActive
      || !Number.isSafeInteger(this.limits.maxRetainedBytes) || this.limits.maxRetainedBytes < 1) {
      throw new Error("invalid async gzip limits");
    }
    this.gzipFn = options.gzip ?? ((input, callback) => {
      gzip(input, (error, result) => callback(error, result));
    });
  }

  reserve(): GzipReservation | null {
    if (this.jobs >= this.limits.maxJobs) return null;
    this.jobs++;
    let state: "reserved" | "submitted" | "released" = "reserved";
    return {
      compress: (input) => {
        if (state !== "reserved") return Promise.reject(new Error("gzip reservation already used"));
        state = "submitted";
        if (input.length > this.limits.maxRetainedBytes - this.retainedBytes) {
          state = "released";
          this.jobs--;
          return Promise.reject(new GzipCapacityError());
        }
        this.retainedBytes += input.length;
        return new Promise<Buffer>((resolve, reject) => {
          this.pending.push({ input, resolve, reject });
          this.pump();
        });
      },
      release: () => {
        if (state !== "reserved") return;
        state = "released";
        this.jobs--;
      },
    };
  }

  get status(): Readonly<{ active: number; queued: number; jobs: number; retainedBytes: number }> {
    return { active: this.active, queued: this.pending.length, jobs: this.jobs, retainedBytes: this.retainedBytes };
  }

  private pump(): void {
    while (this.active < this.limits.maxActive) {
      const job = this.pending.shift();
      if (!job) return;
      this.active++;
      let finished = false;
      const finish = (error: Error | null, result?: Buffer): void => {
        if (finished) return;
        finished = true;
        this.active--;
        this.jobs--;
        this.retainedBytes -= job.input.length;
        if (error) job.reject(error);
        else if (!result) job.reject(new Error("gzip returned no result"));
        else job.resolve(result);
        this.pump();
      };
      try {
        this.gzipFn(job.input, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
