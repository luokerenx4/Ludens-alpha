export function videoPosition(at: number, originAt: number, duration: number) {
  // Never seek exactly past the final encoded frame; a sparse stream can end well before the run.
  return Math.max(0, Math.min((at - originAt) / 1000, Math.max(0, duration - 0.001)));
}

export function videoNeedsSeek(current: number, target: number, playing: boolean) {
  return Math.abs(current - target) > (playing ? 0.2 : 0.015);
}
