/** A logical image retained as a frame of a workspace-owned video segment. */
export interface VideoFrameReference {
  pts: number;
  timeBase: [number, number];
  width: number;
  height: number;
  status?: "gap";
  reason?: string;
}

export interface TimelineAssetReference {
  asset: string;
  video?: VideoFrameReference;
}
