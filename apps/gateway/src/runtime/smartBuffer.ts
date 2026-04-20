export type BufferState = "BUFFERING" | "COMMITTED";

export interface SmartBufferOptions {
  windowMs: number;
  windowBytes: number;
  /**
   * Called when transitioning BUFFERING → COMMITTED. Receives the accumulated
   * chunks (in arrival order) so caller can flush them to the client.
   */
  onCommit: (bufferedChunks: Buffer[]) => void | Promise<void>;
  /**
   * Called for each chunk that arrives AFTER commit (passthrough mode).
   */
  onPassthrough: (chunk: Buffer) => void | Promise<void>;
  /**
   * Time source for tests. Defaults to Date.now.
   */
  now?: () => number;
}

export class SmartBuffer {
  readonly #opts: SmartBufferOptions;
  readonly #now: () => number;
  #state: BufferState = "BUFFERING";
  readonly #startedAt: number;
  #accumulated: Buffer[] = [];
  #accumulatedBytes = 0;

  constructor(opts: SmartBufferOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#startedAt = this.#now();
  }

  get state(): BufferState {
    return this.#state;
  }

  /**
   * Returns elapsed ms since construction when COMMITTED, null while BUFFERING.
   */
  get bufferedAt(): number | null {
    return this.#state === "COMMITTED" ? this.#now() - this.#startedAt : null;
  }

  /**
   * Feed a chunk through the buffer. If the threshold trips, commits + flushes.
   * Returns the post-call state.
   */
  async push(chunk: Buffer): Promise<BufferState> {
    if (this.#state === "COMMITTED") {
      await this.#opts.onPassthrough(chunk);
      return "COMMITTED";
    }

    this.#accumulated = [...this.#accumulated, chunk];
    this.#accumulatedBytes += chunk.length;

    const elapsed = this.#now() - this.#startedAt;
    const sizeHit = this.#accumulatedBytes >= this.#opts.windowBytes;
    const timeHit = elapsed >= this.#opts.windowMs;

    if (sizeHit || timeHit) {
      await this.#commit();
    }

    return this.#state;
  }

  /**
   * Force commit (e.g., upstream completed before window expired).
   * Idempotent: no-op if already COMMITTED.
   */
  async commit(): Promise<void> {
    if (this.#state === "BUFFERING") {
      await this.#commit();
    }
  }

  /**
   * Discard buffered chunks. Caller invokes this when failing over within
   * the BUFFERING window. No-op if already COMMITTED.
   */
  discard(): void {
    if (this.#state === "BUFFERING") {
      this.#accumulated = [];
      this.#accumulatedBytes = 0;
    }
  }

  /**
   * True if upstream errors at this state should trigger failover (vs.
   * emitting event:error to the client).
   */
  isFailoverEligible(): boolean {
    return this.#state === "BUFFERING";
  }

  async #commit(): Promise<void> {
    this.#state = "COMMITTED";
    const chunks = this.#accumulated;
    this.#accumulated = [];
    this.#accumulatedBytes = 0;
    if (chunks.length > 0) {
      await this.#opts.onCommit(chunks);
    }
  }
}
