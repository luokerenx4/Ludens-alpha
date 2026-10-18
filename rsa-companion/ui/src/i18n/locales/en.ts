// Pet settings translations copied from OpenAlice.
export const messages = {
  pet: {
    title: 'Pet', sound: 'Click sound',
    description: 'Personalize your desktop pet’s click sound. Dragging stays silent. Settings are saved on this device.',
    enabled: 'Play sound on click', volume: 'Volume', file: 'Sound file',
    noFile: 'No sound selected — clicks are silent.',
    fileHelp: 'WAV, MP3 or OGG · up to 2 MB and 10 seconds. A local copy is saved; nothing is uploaded.',
    choose: 'Choose audio…', preview: 'Preview', reset: 'Restore defaults',
    resetHelp: 'Restore defaults returns to OpenAlice’s built-in soft double click sound and resets volume to 50%. Preview plays even when click sounds are off.',
    loading: 'Loading pet settings…', saving: 'Saving…',
    desktopOnly: 'Pet sound settings are available in the desktop app when the pet is enabled.',
    error: { unavailable: 'Pet settings are unavailable. Try reopening this page.', invalidFile: 'Choose a playable WAV, MP3 or OGG file, up to 2 MB and 10 seconds.', failed: 'Could not save pet settings. Please try again.', playback: 'Could not play this audio. Choose another file.' },
  },
  activityPreferences: {
    title: 'Activity notifications', description: 'Choose which log content Alice shows. The complete run history stays unchanged.',
    desktopOnly: 'Activity notification preferences require the desktop app.',
    enabled: 'Automatic notifications', main: 'Window notifications when bubbles are unavailable', pet: 'Alice bubbles',
    brief: 'Private bubbles · show short status only', blocks: 'Visible log content',
    block: { thinking: 'Thinking', text: 'Text', tool: 'Tool calls', system: 'System events', diagnostic: 'Debug details' },
    pause: 'Pause for 1 hour', resume: 'Resume notifications', reset: 'Restore content defaults', paused: 'Paused until {{time}}.',
    local: 'Saved locally on this desktop. Pet visibility is separate. Restoring defaults resets content switches; visibility and pause remain unchanged.',
    error: 'Could not load or save notification preferences. Confirmed settings are retained. Try again.',
  },
}
