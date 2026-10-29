import type { PetState, PetTarget, PetTargetReceipt } from "../lib/pet";

export interface PetFollowSnapshot {
  state: PetState | null;
  pending: boolean;
  reading: boolean;
  readError: string;
  writeError: string;
  requested: string | null | undefined;
  lastReadAt: number | null;
  lastSaved: PetTarget | null | undefined;
  canWrite: boolean;
}

/** One owner for the saved selection and its independently observed desktop state. */
export function createPetFollowResource({ read, write, onChange, intervalMs = 2500, timeoutMs = 8000 }: {
  read(signal: AbortSignal): Promise<PetState>;
  write(project: string | null, signal: AbortSignal): Promise<PetTargetReceipt>;
  onChange(snapshot: PetFollowSnapshot): void;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  let active = true, generation = 0;
  let readController: AbortController | null = null, writeController: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: PetFollowSnapshot = { state: null, pending: false, reading: false, readError: "", writeError: "",
    requested: undefined, lastReadAt: null, lastSaved: undefined, canWrite: false };
  const update = (patch: Partial<PetFollowSnapshot>) => {
    if (!active) return;
    state = { ...state, ...patch };
    state.canWrite = !!state.state && !state.pending && !state.readError && !state.writeError;
    onChange(state);
  };
  const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
  const bounded = async <T,>(controller: AbortController, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const deadline = setTimeout(() => controller.abort(new Error("Pet request timed out")), timeoutMs);
    let cancelled: () => void = () => {};
    try {
      return await new Promise<T>((resolve, reject) => {
        cancelled = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", cancelled, { once: true });
        void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return action(controller.signal); }).then(resolve, reject);
      });
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", cancelled);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    // An uncertain write stays visible until the user explicitly reads the saved choice.
    if (active && !state.pending && !state.writeError) timer = setTimeout(() => { void refresh(); }, intervalMs);
  };
  const refresh = async () => {
    if (!active || readController || state.pending) return;
    clearTimeout(timer);
    const controller = new AbortController(), started = generation;
    readController = controller;
    update({ reading: true });
    try {
      const next = await bounded(controller, read);
      if (!active || controller.signal.aborted || started !== generation) return;
      update({ state: next, lastReadAt: Date.now(), readError: "", writeError: "", requested: undefined, lastSaved: undefined });
    } catch (error) {
      if (active && started === generation) update({ readError: failure(error) });
    } finally {
      if (readController === controller) readController = null;
      if (active && started === generation) { update({ reading: false }); schedule(); }
    }
  };
  const follow = async (project: string | null) => {
    if (!active || !state.canWrite) return;
    clearTimeout(timer);
    const started = ++generation;
    readController?.abort(); readController = null;
    const controller = new AbortController(); writeController = controller;
    update({ pending: true, reading: false, requested: project, writeError: "", lastSaved: undefined });
    let committed = false;
    try {
      const receipt = await bounded(controller, signal => write(project, signal));
      if (!active || controller.signal.aborted || started !== generation) return;
      // A write receipt confirms the selection, never that a desktop has applied it.
      update({ state: { target: receipt.target, targetConfigured: true, consumer: null, connected: null }, lastSaved: receipt.target,
        lastReadAt: null, readError: "", requested: undefined });
      committed = true;
    } catch (error) {
      if (active && started === generation) update({ writeError: failure(error) });
    } finally {
      if (writeController === controller) writeController = null;
      if (active && started === generation) {
        update({ pending: false });
        if (committed) void refresh();
      }
    }
  };
  return { refresh, follow, snapshot: () => state, dispose() {
    active = false; generation++;
    clearTimeout(timer); readController?.abort(); writeController?.abort();
  } };
}
