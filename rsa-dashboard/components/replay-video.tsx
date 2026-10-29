"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayFrame } from "../lib/replay-types";
import { selectVideoSource, videoResourceKey, videoSyncState } from "./replay-video-model";
import { useTranslations } from "@/lib/locale";

type Source = NonNullable<ReplayFrame["media"][number]["video"]>;
type Ready = (slot: string, url: string, ready: boolean) => void;

/** Each mounted segment has its own decoder; the old surface stays until the new frame has decoded. */
function Surface({ source, at, sampledAt, playing, clockReady, speed, visible, current, onReady, onError, label }: {
  source: Source; at: number; sampledAt: number; playing: boolean; clockReady: boolean; speed: number; visible: boolean; current: boolean;
  onReady(url: string, ready: boolean): void; onError(url: string): void; label: string;
}) {
  const element = useRef<HTMLVideoElement>(null);
  const control = useRef({ source, at, sampledAt, playing, clockReady, speed, current, onReady });
  control.current = { source, at, sampledAt, playing, clockReady, speed, current, onReady };
  const sync = useCallback(() => {
    const video = element.current, c = control.current;
    if (!video || !c.current) { video?.pause(); return; }
    if (!video.readyState) { c.onReady(c.source.url, false); return; }
    const state = videoSyncState({ at: c.at, sampledAt: c.sampledAt, originAt: c.source.originAt,
      duration: c.source.durationSeconds, currentTime: video.currentTime, readyState: video.readyState,
      seeking: video.seeking, ended: video.ended, playing: c.playing, clockReady: c.clockReady });
    video.playbackRate = c.speed;
    if (state.seek) {
      video.currentTime = state.target;
      c.onReady(c.source.url, false);
      return;
    }
    c.onReady(c.source.url, state.ready);
    if (state.play) {
      if (video.paused) void video.play().catch(error => {
        if (error.name !== "AbortError") onError(c.source.url);
      });
    } else video.pause();
  }, [onError]);
  useEffect(sync, [sync, source.url, source.originAt, source.durationSeconds, at, sampledAt, playing, clockReady, speed, current]);
  useEffect(() => {
    const video = element.current;
    // Development StrictMode replays setup after cleanup without remounting the DOM node.
    if (video && video.getAttribute("src") !== source.url) video.src = source.url;
    return () => { video?.pause(); video?.removeAttribute("src"); video?.load(); };
  }, [source.url]);
  return <video ref={element} src={source.url} muted playsInline preload="auto" aria-label={label} aria-hidden={!visible}
    width={source.width} height={source.height} className={visible ? "replay-video-surface visible" : "replay-video-surface"}
    onLoadedMetadata={sync} onLoadedData={sync} onSeeked={sync} onCanPlay={sync} onEnded={sync} onTimeUpdate={sync}
    onWaiting={sync} onError={() => current && onError(source.url)} />;
}

export function ReplayVideo({ source, at, sampledAt, playing, clockReady, speed, slot, onReady, label }: {
  source: Source; at: number; sampledAt: number; playing: boolean; clockReady: boolean; speed: number; slot: string; onReady: Ready; label: string;
}) {
  const t = useTranslations("replayVideo");
  const resource = useRef(source);
  const [shown, setShown] = useState<Source | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  resource.current = selectVideoSource(resource.current, source, at, sampledAt,
    failure === videoResourceKey(resource.current));
  source = resource.current;
  const target = useRef(source);
  target.current = source;
  const report = useCallback((url: string, ready: boolean) => {
    if (target.current.url !== url) return;
    if (ready) setShown(previous => previous?.url === url ? previous : target.current);
    onReady(slot, target.current.assetId, ready);
  }, [slot, onReady]);
  const failed = useCallback((url: string) => {
    if (target.current.url === url) {
      setFailure(videoResourceKey(target.current));
      onReady(slot, target.current.assetId, target.current.status !== "pending");
    }
  }, [slot, onReady]);
  const failedResource = failure === videoResourceKey(source);
  const error = source.status === "gap" || source.status === "error" || failedResource && source.status !== "pending";
  // Fragmented segments stream while pending; legacy ones stay paused until ready.
  const pending = source.status === "pending" && (!source.streaming || failedResource);
  useEffect(() => {
    if (pending) onReady(slot, source.assetId, false);
  }, [pending, slot, source.assetId, onReady]);
  const playable = !error && !pending;
  // At most two decoders per channel, including a segment transition.
  const sources = [...(shown && (shown.url !== source.url || !playable) && !error ? [shown] : []), ...(playable ? [source] : [])];
  return <div className="replay-video-stack">
    {sources.map(value => <Surface key={value.url} source={value} at={at} sampledAt={sampledAt} playing={playing} clockReady={clockReady}
      speed={speed} current={playable && value.url === source.url} visible={shown?.url === value.url}
      onReady={report} onError={failed} label={label} />)}
    {error ? <div className="replay-media-missing" role="status">{source.reason ?? t("unavailable")}<small>{t("gapKept")}</small></div>
      : pending ? <span className="replay-video-status" role="status">{failedResource ? t("unreadableWaiting") : t("writingSegment")}{shown && ` · ${t("keepPrevious")}`}</span>
      : shown?.url !== source.url ? <span className="replay-video-status" role="status">{t("buffering")}</span> : null}
  </div>;
}
