export function videoPosition(at: number, originAt: number) {
  return Math.max(0, (at - originAt) / 1000);
}

export function videoSyncState(state: { at: number; originAt: number; sampledAt: number; duration: number;
  currentTime: number; readyState: number; seeking: boolean; ended: boolean; playing: boolean; clockReady: boolean }) {
  const clock = videoPosition(state.at, state.originAt);
  // Chromium can report ended with HAVE_METADATA (and while a seek is settling)
  // at the last sample PTS, before the container's final display interval ends.
  // Holding that frame must not stop the common clock from reaching the next clip.
  if (state.ended && clock >= state.currentTime - 0.000001)
    return { target: state.currentTime, seek: false, ready: true, play: false };
  const sample = videoPosition(Math.min(state.at, state.sampledAt), state.originAt);
  // Continuous playback follows time between samples, including 1Hz recordings.
  // Only a missing decoded frame or a finished interval needs an exact sample PTS.
  const target = state.readyState < 2 || clock >= state.duration ? sample : clock;
  const seek = state.readyState > 0 && !state.seeking && (videoNeedsSeek(state.currentTime, target, state.playing)
    // Recover a decoder waiting beyond its last actual frame by seeking the
    // recorded sample, even when that discrepancy is below the playback tolerance.
    || state.readyState < 2 && !state.ended && Math.abs(state.currentTime - target) > 0.000001);
  const ready = !seek && !state.seeking && (state.readyState >= 2 || state.ended);
  return { target, seek, ready,
    // Buffering freezes the shared clock, not the user's playback intent. Let
    // the decoder resume naturally; an ended segment holds its final frame.
    play: state.playing && !state.ended && state.at < state.originAt + state.duration * 1000 && (state.clockReady || !ready) };
}

export function videoNeedsSeek(current: number, target: number, playing: boolean) {
  return Math.abs(current - target) > (playing ? 0.2 : 0.015);
}
