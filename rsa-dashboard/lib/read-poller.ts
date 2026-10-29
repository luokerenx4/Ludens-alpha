/** Schedule read-only snapshots without treating a pause as a new selection. */
export class ReadPoller {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private enabled: boolean;

  constructor(private read: (signal: AbortSignal) => Promise<number>, enabled: boolean) {
    this.enabled = enabled;
  }

  /** Explicit selection/reset reads are allowed even while automatic refresh is paused. */
  async readOnce() {
    if (this.running || this.controller.signal.aborted) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    let delay = 2500;
    try {
      delay = await this.read(this.controller.signal);
    } finally {
      this.running = false;
      if (this.enabled && !this.controller.signal.aborted)
        this.timer = setTimeout(() => { void this.readOnce(); }, delay);
    }
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled || this.controller.signal.aborted) return;
    this.enabled = enabled;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (enabled) void this.readOnce();
  }

  dispose() {
    this.controller.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
