export interface DesktopFailure { code: "failed" | "unconfirmed" | "invalidFile"; detail: string }
export interface DesktopResourceState<T> {
  value: T | null;
  loading: boolean;
  pending: boolean;
  readError: string | null;
  writeError: DesktopFailure | null;
}

export class DesktopResourceCancelled extends Error {}
class DesktopWriteUnconfirmed extends Error {}

/** IPC cannot be aborted, so each result is scoped to its bridge and operation lifetime. */
export function createDesktopResource<T>({ read, subscribe, isCurrent, onChange, timeoutMs = 8000 }: {
  read(): Promise<T>;
  subscribe(callback: (value: T) => void): () => void;
  isCurrent(): boolean;
  onChange(state: DesktopResourceState<T>): void;
  timeoutMs?: number;
}) {
  let active = true, readId = 0, writeId = 0, notifications = 0;
  let unsubscribe: (() => void) | undefined;
  let state: DesktopResourceState<T> = { value: null, loading: false, pending: false, readError: null, writeError: null };
  const cancellations = new Set<() => void>();
  const current = () => active && isCurrent();
  const update = (patch: Partial<DesktopResourceState<T>>) => {
    if (!current()) return;
    state = { ...state, ...patch }; onChange(state);
  };
  const timed = <V,>(action: () => Promise<V>, write = false): Promise<V> => new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); cancellations.delete(cancel); };
    const cancel = () => { finish(); reject(new DesktopResourceCancelled()); };
    const timer = setTimeout(() => { finish(); reject(write ? new DesktopWriteUnconfirmed("Desktop response timed out") : new Error("Desktop response timed out")); }, timeoutMs);
    cancellations.add(cancel);
    void Promise.resolve().then(() => {
      if (!current()) throw new DesktopResourceCancelled();
      return action();
    }).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
  const retry = async () => {
    if (!current() || state.loading || state.pending) return;
    const id = ++readId, observed = notifications;
    update({ loading: true });
    try {
      if (!unsubscribe) unsubscribe = subscribe(value => {
        if (!current()) return;
        notifications++;
        update({ value, loading: false, readError: null, writeError: null });
      });
      const value = await timed(read);
      if (current() && id === readId) update({ ...(observed === notifications ? { value } : {}), loading: false, readError: null, writeError: null });
    } catch (error) {
      if (current() && id === readId) update({ loading: false,
        ...(observed === notifications ? { readError: error instanceof Error ? error.message : String(error) } : {}) });
    }
  };
  const write = async (action: (stillCurrent: () => boolean) => Promise<T>): Promise<boolean> => {
    if (!current() || state.pending || state.value === null || (state.writeError && state.writeError.code !== "invalidFile")) return false;
    const id = ++writeId, observed = notifications;
    readId++;
    update({ pending: true, loading: false, writeError: null });
    const stillCurrent = () => current() && id === writeId;
    try {
      const value = await timed(() => action(stillCurrent), true);
      if (!stillCurrent()) return false;
      update({ ...(observed === notifications ? { value } : {}), readError: null });
      return true;
    } catch (error) {
      if (stillCurrent() && !(error instanceof DesktopResourceCancelled)) update({ writeError: {
        code: error instanceof Error && error.message === "invalidFile" ? "invalidFile"
          : error instanceof DesktopWriteUnconfirmed ? "unconfirmed" : "failed",
        detail: error instanceof Error ? error.message : String(error),
      } });
      return false;
    } finally {
      if (stillCurrent()) { writeId++; update({ pending: false }); }
    }
  };
  return { retry, write, current, snapshot: () => state, dispose() {
    active = false; readId++; writeId++;
    try { unsubscribe?.(); } catch { /* The bridge may already have closed. */ }
    for (const cancel of [...cancellations]) cancel();
  } };
}
