import type { LogBlock } from "./activity";

export type BlockKind = LogBlock["kind"];
export interface PetSoundSettings {
  enabled: boolean;
  volume: number;
  source: { name: string; dataUrl: string } | null;
}
export interface ActivityPreferences {
  version: 2;
  defaultsVersion: number;
  enabled: boolean;
  blocks: Record<BlockKind, boolean>;
  main: boolean;
  pet: boolean;
  brief: boolean;
  pausedUntil: number;
}
export type ActivityDisplay =
  | { type: "hide"; displayId: string }
  | {
      type: "show";
      displayId: string;
      input: {
        title?: string;
        description?: string;
        status?: string;
        block?: LogBlock;
      };
    };
export interface DesktopCompanion {
  getSound(): Promise<PetSoundSettings>;
  updateSound(settings: Partial<PetSoundSettings>): Promise<PetSoundSettings>;
  resetSound(): Promise<PetSoundSettings>;
  onSound(callback: (settings: PetSoundSettings) => void): () => void;
  getVisible(): Promise<boolean>;
  toggle(): Promise<boolean>;
  onVisibility(callback: (visible: boolean) => void): () => void;
  activity: {
    getPreferences(): Promise<ActivityPreferences>;
    updatePreferences(
      input: Partial<ActivityPreferences>,
    ): Promise<ActivityPreferences>;
    resetPreferences(): Promise<ActivityPreferences>;
    onPreferences(callback: (input: ActivityPreferences) => void): () => void;
    onDisplay(callback: (input: ActivityDisplay) => void): () => void;
    onOpen(callback: (url: string) => void): () => void;
    open(displayId: string): Promise<boolean>;
    dismiss(displayId: string): Promise<boolean>;
  };
}
export interface DesktopSnapshot {
  workspace: string;
  dashboardUrl: string;
  runId: string | null;
}
declare global {
  interface Window {
    readonly ludens?: { readonly companion?: DesktopCompanion };
    readonly rsaPet?: {
      getSnapshot(): Promise<DesktopSnapshot>;
      onSnapshot(callback: (snapshot: DesktopSnapshot) => void): () => void;
      openDashboard(): Promise<void>;
    };
  }
}

/** Keep native deep links inside the configured application, including in Web previews. */
export function localDashboardLink(
  input: string,
  current: string,
): string | null {
  try {
    const url = new URL(input, current),
      base = new URL(current);
    return url.origin === base.origin && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
