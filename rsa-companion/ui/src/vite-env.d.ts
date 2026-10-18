/// <reference types="vite/client" />

interface PetSoundSettings {
  enabled: boolean
  volume: number
  source: { name: string; dataUrl: string } | null
}

type RsaPetSnapshot = import('../../apps/desktop/src/rsa-source').RsaPetSnapshot

interface Window {
  readonly rsaPet?: {
    getSnapshot(): Promise<RsaPetSnapshot>
    onSnapshot(callback: (snapshot: RsaPetSnapshot) => void): () => void
    openDashboard(): Promise<void>
  }
  readonly openAlice?: {
    readonly companion?: {
      readonly activity?: {
        getPreferences(): Promise<import('../../apps/desktop/src/activity-policy').ActivityPreferences>
        updatePreferences(input: Partial<import('../../apps/desktop/src/activity-policy').ActivityPreferences>): Promise<import('../../apps/desktop/src/activity-policy').ActivityPreferences>
        resetPreferences(): Promise<import('../../apps/desktop/src/activity-policy').ActivityPreferences>
        onPreferences(callback: (input: import('../../apps/desktop/src/activity-policy').ActivityPreferences) => void): () => void
        onDisplay(callback: (input: import('../../apps/desktop/src/activity-controller').ActivityDisplay) => void): () => void
        onOpen(callback: (context: string) => void): () => void
        open(displayId: string): Promise<boolean>
        dismiss(displayId: string): Promise<boolean>
      }
      getSound(): Promise<PetSoundSettings>
      updateSound(settings: Partial<PetSoundSettings>): Promise<PetSoundSettings>
      resetSound(): Promise<PetSoundSettings>
      onSound(callback: (settings: PetSoundSettings) => void): () => void
      getVisible(): Promise<boolean>
      toggle(): Promise<boolean>
      onVisibility(callback: (visible: boolean) => void): () => void
    }
  }
}
