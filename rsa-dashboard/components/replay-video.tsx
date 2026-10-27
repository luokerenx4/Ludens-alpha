"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplayFrame } from "../lib/replay-types";
import { videoNeedsSeek, videoPosition } from "./replay-video-model";

type Source = NonNullable<ReplayFrame["media"][number]["video"]>;
type Ready = (slot: string, url: string, ready: boolean) => void;

/** Each mounted segment has its own decoder; the old surface stays until the new frame has decoded. */
function Surface({ source, at, playing, speed, visible, current, onReady, onError, label }: {
  source: Source; at: number; playing: boolean; speed: number; visible: boolean; current: boolean;
  onReady(url: string, ready: boolean): void; onError(url: string): void; label: string;
}) {
  const element = useRef<HTMLVideoElement>(null);
  const control = useRef({ source, at, playing, speed, current, onReady });
  control.current = { source, at, playing, speed, current, onReady };
  const sync = useCallback(() => {
    const video = element.current, c = control.current;
    if (!video || !c.current) { video?.pause(); return; }
    if (!video.readyState) { c.onReady(c.source.url, false); return; }
    const target = videoPosition(c.at, c.source.originAt, c.source.durationSeconds);
    video.playbackRate = c.speed;
    if (!video.seeking && videoNeedsSeek(video.currentTime, target, c.playing)) {
      video.currentTime = target;
      c.onReady(c.source.url, false);
      return;
    }
    const ready = !video.seeking && video.readyState >= 2;
    c.onReady(c.source.url, ready);
    const atEnd = c.at >= c.source.originAt + c.source.durationSeconds * 1000;
    if (c.playing && ready && !atEnd) {
      if (video.paused) void video.play().catch(error => {
        if (error.name !== "AbortError") onError(c.source.url);
      });
    } else video.pause();
  }, [onError]);
  useEffect(sync, [sync, source.url, source.originAt, source.durationSeconds, at, playing, speed, current]);
  useEffect(() => {
    const video = element.current;
    // Development StrictMode replays setup after cleanup without remounting the DOM node.
    if (video && video.getAttribute("src") !== source.url) video.src = source.url;
    return () => { video?.pause(); video?.removeAttribute("src"); video?.load(); };
  }, [source.url]);
  return <video ref={element} src={source.url} muted playsInline preload="auto" aria-label={label} aria-hidden={!visible}
    width={source.width} height={source.height} className={visible ? "replay-video-surface visible" : "replay-video-surface"}
    onLoadedMetadata={sync} onLoadedData={sync} onSeeked={sync} onCanPlay={sync} onEnded={sync}
    onWaiting={() => current && onReady(source.url, false)} onError={() => current && onError(source.url)} />;
}

export function ReplayVideo({ source, at, playing, speed, slot, onReady, label }: {
  source: Source; at: number; playing: boolean; speed: number; slot: string; onReady: Ready; label: string;
}) {
  const [shown, setShown] = useState<Source | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const target = useRef(source);
  target.current = source;
  const report = useCallback((url: string, ready: boolean) => {
    if (target.current.url !== url) return;
    if (ready) setShown(previous => previous?.url === url ? previous : target.current);
    onReady(slot, url, ready);
  }, [slot, onReady]);
  const failed = useCallback((url: string) => {
    if (target.current.url === url) { setFailure(url); onReady(slot, url, true); }
  }, [slot, onReady]);
  const error = source.status === "gap" || source.status === "error" || failure === source.url;
  const pending = source.status === "pending";
  const playable = !error && !pending;
  // At most two decoders per channel, including a segment transition.
  const sources = [...(shown && shown.url !== source.url && !error ? [shown] : []), ...(playable ? [source] : [])];
  return <div className="replay-video-stack">
    {sources.map(value => <Surface key={value.url} source={value} at={at} playing={playing}
      speed={speed} current={value.url === source.url} visible={shown?.url === value.url}
      onReady={report} onError={failed} label={label} />)}
    {error ? <div className="replay-media-missing" role="status">{source.reason ?? "视频不可用"}<small>保留此处的录制缺口。</small></div>
      : pending ? <span className="replay-video-status" role="status">片段正在写入…{shown && " · 保留上一画面"}</span>
      : shown?.url !== source.url ? <span className="replay-video-status" role="status">正在缓冲视频…</span> : null}
  </div>;
}
