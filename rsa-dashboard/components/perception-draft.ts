import type { PerceptionSettings, PerceptionSettingsPatch } from "../lib/perception-config";

export const PERCEPTION_FIELDS = {
  hotSeconds: { min: 10, max: 3600, fallback: 600, presets: [60, 300, 600, 1800] },
  videoSegmentSeconds: { min: 10, max: 3600, fallback: 300, presets: [60, 300, 900, 1800] },
  videoIdleSeconds: { min: 1, max: 600, fallback: 10, presets: [5, 10, 30, 60] },
} as const;
export type PerceptionKey = keyof PerceptionSettings;
export const PERCEPTION_KEYS = Object.keys(PERCEPTION_FIELDS) as PerceptionKey[];
export type SavedPerception = Partial<PerceptionSettings>;
export type PerceptionFieldDraft = { mode: "inherit" | "override"; raw: string; base?: number };
export type PerceptionDraft = Partial<Record<PerceptionKey, PerceptionFieldDraft>>;
export type PerceptionWriteState = "idle" | "saving" | "saved" | "unconfirmed" | "review" | "matched";
export interface PerceptionSessionState {
  settings: SavedPerception | null;
  draft: PerceptionDraft;
  reading: boolean;
  readError: string;
  writeState: PerceptionWriteState;
  writeError: string;
  submitted: PerceptionSettingsPatch | null;
  settingsRevision: number;
  persistence: "session" | "memory";
}
export const EMPTY_PERCEPTION_SESSION: PerceptionSessionState = {
  settings: null, draft: {}, reading: false, readError: "", writeState: "idle", writeError: "",
  submitted: null, settingsRevision: 0, persistence: "session",
};

export function parsePerceptionDraft(key: PerceptionKey, draft: PerceptionFieldDraft): number | null | undefined {
  if (draft.mode === "inherit") return null;
  const { min, max } = PERCEPTION_FIELDS[key];
  if (!/^\d+$/.test(draft.raw.trim())) return undefined;
  const value = Number(draft.raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}
export function perceptionPatch(draft: PerceptionDraft) {
  const patch: PerceptionSettingsPatch = {}, invalid: PerceptionKey[] = [];
  for (const key of PERCEPTION_KEYS) if (draft[key]) {
    const value = parsePerceptionDraft(key, draft[key]!);
    if (value === undefined) invalid.push(key); else patch[key] = value;
  }
  return { patch, invalid };
}
export function normalizePerceptionDraft(draft: PerceptionDraft, settings: SavedPerception): PerceptionDraft {
  const result = { ...draft };
  for (const key of PERCEPTION_KEYS) if (draft[key]) {
    const field = draft[key]!;
    const parsed = parsePerceptionDraft(key, field);
    if (field.mode === "inherit" ? settings[key] === undefined
      : typeof parsed === "number" && parsed === settings[key]
        || settings[key] !== undefined && field.raw.trim() === String(settings[key])) delete result[key];
  }
  return result;
}
function validSettings(value: unknown): value is SavedPerception {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => PERCEPTION_KEYS.includes(key as PerceptionKey) && typeof item === "number" && Number.isFinite(item) && item > 0);
}
interface SessionStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** A tab-scoped editor lifetime, independent of whether its page is mounted. */
export function createPerceptionSession({ scope, storage, read, write }: {
  scope: string;
  storage?: SessionStorage;
  read(signal: AbortSignal): Promise<SavedPerception>;
  write(patch: PerceptionSettingsPatch): Promise<SavedPerception>;
}) {
  const key = "ludens-perception-draft-v1:" + scope;
  const listeners = new Set<() => void>();
  let state: PerceptionSessionState = { ...EMPTY_PERCEPTION_SESSION, draft: {}, persistence: storage ? "session" : "memory" };
  let reader: AbortController | null = null;
  let readVersion = 0;
  try {
    const text = storage?.getItem(key);
    if (text) {
      const value = JSON.parse(text), draft: PerceptionDraft = {};
      if (value?.version === 1 && value.scope === scope) {
        for (const name of PERCEPTION_KEYS) {
          const item = value.draft?.[name];
          if (item && (item.mode === "inherit" || item.mode === "override") && typeof item.raw === "string" && item.raw.length <= 100)
            draft[name] = { mode: item.mode, raw: item.raw, ...(typeof item.base === "number" && Number.isFinite(item.base) ? { base: item.base } : {}) };
        }
        const submitted = value.submitted && typeof value.submitted === "object" && !Array.isArray(value.submitted)
          && Object.entries(value.submitted).every(([name, item]) => PERCEPTION_KEYS.includes(name as PerceptionKey) && (item === null || typeof item === "number" && Number.isFinite(item))) ? value.submitted : null;
        state = { ...state, settings: validSettings(value.settings) ? value.settings : null, draft,
          writeState: value.writeState === "saving" || value.writeState === "unconfirmed" ? "unconfirmed" : value.writeState === "saved" ? "saved" : "idle",
          writeError: typeof value.writeError === "string" ? value.writeError : "", submitted };
      }
    }
  } catch { storage = undefined; state.persistence = "memory"; }
  const persist = () => {
    if (!storage) return;
    try { storage.setItem(key, JSON.stringify({ version: 1, scope, settings: state.settings, draft: state.draft,
      writeState: state.writeState, writeError: state.writeError, submitted: state.submitted })); }
    catch { storage = undefined; state = { ...state, persistence: "memory" }; }
  };
  const update = (patch: Partial<PerceptionSessionState>) => { state = { ...state, ...patch }; persist(); for (const listener of listeners) listener(); };
  persist();
  const cancelRead = () => { readVersion++; reader?.abort(); reader = null; };
  const refresh = async () => {
    if (state.reading || state.writeState === "saving") return;
    cancelRead(); const controller = new AbortController(), version = readVersion; reader = controller;
    update({ reading: true });
    try {
      const settings = await read(controller.signal);
      if (controller.signal.aborted || version !== readVersion) return;
      if (!validSettings(settings)) throw new Error("Invalid saved perception settings");
      const uncertain = state.writeState === "unconfirmed";
      const confirmed = state.submitted && Object.entries(state.submitted).every(([name, value]) => settings[name as PerceptionKey] === (value ?? undefined));
      update({ settings, draft: normalizePerceptionDraft(state.draft, settings), reading: false, readError: "",
        settingsRevision: state.settingsRevision + (JSON.stringify(settings) === JSON.stringify(state.settings) ? 0 : 1),
        ...(uncertain ? { writeState: confirmed ? "matched" : "review", submitted: null, writeError: "" } : {}) });
    } catch (error) {
      if (!controller.signal.aborted && version === readVersion) update({ reading: false, readError: error instanceof Error ? error.message : String(error) });
    } finally { if (reader === controller) reader = null; }
  };
  const edit = (name: PerceptionKey, mode: PerceptionFieldDraft["mode"], raw: string) => {
    if (state.writeState === "saving" || !state.settings) return;
    const previous = state.draft[name];
    const field = { mode, raw: raw.slice(0, 100), base: previous ? previous.base : state.settings[name] };
    update({ draft: normalizePerceptionDraft({ ...state.draft, [name]: field }, state.settings),
      ...(state.writeState === "saved" || state.writeState === "matched" ? { writeState: "idle" } : {}) });
  };
  const save = async () => {
    const { patch, invalid } = perceptionPatch(state.draft);
    if (!state.settings || state.writeState === "saving" || state.writeState === "unconfirmed" || invalid.length || !Object.keys(patch).length) return false;
    cancelRead(); update({ reading: false, writeState: "saving", writeError: "", submitted: patch, settingsRevision: state.settingsRevision + 1 });
    try {
      const settings = await write(patch);
      if (!validSettings(settings)) throw new Error("Invalid saved perception settings response");
      update({ settings, draft: normalizePerceptionDraft(state.draft, settings), writeState: "saved", writeError: "",
        readError: "", submitted: null, settingsRevision: state.settingsRevision + 1 });
      return true;
    } catch (error) {
      update({ writeState: "unconfirmed", writeError: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  return { snapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, edit, save, discard() {
      if (state.writeState === "saving") return;
      update({ draft: {}, ...(state.writeState !== "unconfirmed" ? { writeState: "idle", writeError: "" } : {}) });
    } };
}
export type PerceptionSession = ReturnType<typeof createPerceptionSession>;

export function perceptionReloadCommand(workspace: string) {
  return `env -u RSA_SOCKET rsa --workspace '${workspace.replace(/'/g, "'\\''")}' perception reload`;
}
