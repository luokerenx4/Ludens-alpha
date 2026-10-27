"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayDetail, ReplayFrame, ReplayItem, ReplayOverview, ReplayWindow } from "../lib/replay-types";
import { adjacentReplayFrame, clampReplayTime, mergeReplayPages, nearbyReplayItems, REPLAY_WINDOW_MS,
  replayDuration, replayFramesAt, replayItemActive, replayTrackLabels, replayTracks, replayWindowBounds,
  retainReplayWindows } from "./replay-model";
import { useBufferedMedia } from "./use-buffered-media";
import type { BufferedImage } from "./image-buffer";
import { ReplayVideo } from "./replay-video";
import "./timeline-player.css";

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "读取回放失败");
  return result;
}
const endpoint = (scope: string, params: Record<string, string | number>) =>
  "/api/replay?" + scope + "&" + new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));

async function readWindow(scope: string, start: number, end: number, signal: AbortSignal) {
  const pages: ReplayWindow[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read<ReplayWindow>(endpoint(scope, { mode: "window", start, end, ...(cursor ? { cursor } : {}) }), signal);
    pages.push(page);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("回放分页没有前进，请重试");
    if (cursor && pages.length >= 10) throw new Error("这一段记录过于密集，请在时间轴上选择更短的时间窗后重试。尚未载入的记录没有被丢弃。");
    if (cursor) cursors.add(cursor);
  } while (cursor && !signal.aborted);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return mergeReplayPages(pages);
}

const wallTime = (at: number) => new Date(at).toLocaleTimeString("zh-CN", {
  hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
});
const statusLabel: Record<string, string> = { completed: "完成", success: "完成", error: "失败", failed: "失败",
  cancelled: "取消", pending: "进行中", running: "进行中" };

type VideoPlayback = { at: number; playing: boolean; speed: number; onReady(slot: string, url: string, ready: boolean): void };
function ReplayMedia({ media, label, image, playback, slot }: { media: ReplayFrame["media"][number]; label: string; image?: BufferedImage;
  playback: VideoPlayback; slot: string }) {
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const error = failure?.url === media.url ? failure.message : "";
  const setError = (message: string) => setFailure({ url: media.url, message });
  const [text, setText] = useState("");
  const isText = media.mediaType.startsWith("text/") || media.mediaType === "application/json";
  useEffect(() => {
    setError(""); setText("");
    if (!isText) return;
    const controller = new AbortController();
    fetch(media.url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 410 ? "记录已过期" : "无法读取记录");
      const value = await response.text();
      if (!controller.signal.aborted) setText(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [media.url, isText]);
  if (media.video) return <ReplayVideo source={media.video} {...playback} slot={slot} label={label} />;
  if (image?.error || error) return <div className="replay-media-missing" role="status">{image?.error || error}<small>此处保留时间位置，播放可以继续。</small></div>;
  if (media.mediaType.startsWith("image/")) return <img src={image?.src} width={image?.width} height={image?.height} alt={label} draggable={false}
    onError={() => setError("画面不可用 · 可能已过期或被移除")} />;
  if (media.mediaType.startsWith("audio/")) return <audio controls preload="none" src={media.url}
    aria-label={label} onError={() => setError("音频不可用")} />;
  if (media.mediaType.startsWith("video/")) return <video controls preload="metadata" src={media.url}
    aria-label={label} onError={() => setError("视频不可用")} />;
  if (isText) return <pre>{text || "读取文字记录…"}</pre>;
  return <a href={media.url} target="_blank" rel="noreferrer">查看 {media.mediaType} 记录 ↗</a>;
}

const FrameMedia = memo(function FrameMedia({ frame, images, playback }: {
  frame: ReplayFrame; images: Map<string, BufferedImage>; playback: VideoPlayback;
}) {
  return <><div className="replay-media-grid">
    {frame.media.map(media => <div className={"replay-media" + (media.mediaType.startsWith("image/") ? " replay-image" : "")} key={media.index}>
      <ReplayMedia media={media} image={images.get(media.url)} playback={playback} slot={frame.capability + ":" + media.index}
        label={frame.capability + " · " + wallTime(frame.at) + " · " + (media.index + 1)} />
    </div>)}
    {!frame.media.length && <p className="replay-no-media">此条感知没有媒体，可展开详情查看数据。</p>}
  </div>
    {frame.text && <details className="replay-frame-text"><summary>观测文字</summary><pre>{frame.text}</pre></details>}
  </>;
});

type Selection = { kind: "frame"; value: ReplayFrame } | { kind: "item"; value: ReplayItem };

function ReplayDetails({ scope, selection, onClose }: { scope: string; selection: Selection; onClose(): void }) {
  const [detail, setDetail] = useState<ReplayDetail | null>(null);
  const [error, setError] = useState("");
  const { value, kind } = selection;
  const url = endpoint(scope, kind === "frame" ? { mode: "detail", record: value.id, sequence: (value as ReplayFrame).sequence }
    : { mode: "detail", id: value.id });
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError("");
    void read<ReplayDetail>(url, controller.signal).then(value => {
      if (!controller.signal.aborted) setDetail(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [url]);
  return <section className="surface replay-detail" aria-label="回放来源详情">
    <div className="surface-heading"><h2>{detail?.title ?? "来源详情"}</h2>
      <button type="button" className="text-button" onClick={onClose}>关闭详情 ×</button></div>
    {error ? <p role="alert">{error}</p> : !detail ? <p role="status">正在读取原始记录…</p> : <>
      {!!detail.observations?.length && <div className="replay-inputs"><h3>模型输入的观测</h3>
        {detail.observations.map(observation => <div key={observation.id}>
          {observation.url ? <img src={observation.url} alt={"模型输入 " + observation.id} loading="lazy" /> : <span>未录制的媒体</span>}
          <small>{observation.recordId ?? observation.id}{observation.sequence ? " · #" + observation.sequence : ""}
            {observation.approximate ? " · 视频还原，与当时输入可能有压缩差异" : ""}</small>
        </div>)}
      </div>}
      <pre>{JSON.stringify(detail.data, null, 2)}</pre>
    </>}
  </section>;
}

export function TimelinePlayer({ project, run, epoch, position, onPosition }: {
  project: string; run: string; epoch?: string; position?: string | null; onPosition(at: number): void;
}) {
  const scope = new URLSearchParams({ project, run, ...(epoch ? { epoch } : {}) }).toString();
  const [overview, setOverview] = useState<ReplayOverview | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [at, setAt] = useState<number>(0);
  const atRef = useRef(at);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [capability, setCapability] = useState("");
  const [windowMs, setWindowMs] = useState(REPLAY_WINDOW_MS);
  const [windows, setWindows] = useState<ReplayWindow[]>([]);
  const cached = useRef(windows);
  const [windowError, setWindowError] = useState("");
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shareState, setShareState] = useState("");
  const stepRequest = useRef<AbortController | null>(null);
  const [stepping, setStepping] = useState(false);
  const [videoReadiness, setVideoReadiness] = useState<Record<string, { url: string; ready: boolean }>>({});
  const onVideoReady = useCallback((slot: string, url: string, ready: boolean) => {
    setVideoReadiness(previous => previous[slot]?.url === url && previous[slot].ready === ready
      ? previous : { ...previous, [slot]: { url, ready } });
  }, []);
  const initialPosition = useRef(position);
  const hasOverview = useRef(false);
  const positionApplied = useRef<string | null | undefined>(undefined);
  const move = useCallback((next: number) => { atRef.current = next; setAt(next); }, []);

  useEffect(() => {
    if (!project || !run) return;
    const controller = new AbortController();
    setRefreshing(true); setOverviewError("");
    void read<ReplayOverview>(endpoint(scope, { mode: "overview" }), controller.signal).then(next => {
      if (controller.signal.aborted) return;
      if (!hasOverview.current) {
        hasOverview.current = true;
        move(clampReplayTime(Number(initialPosition.current ?? next.startAt), next));
      }
      setOverview(next);
    }).catch(error => { if (!controller.signal.aborted) setOverviewError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [scope, project, run, refresh, move]);

  useEffect(() => {
    if (!overview || position === positionApplied.current) return;
    positionApplied.current = position;
    if (position != null) { setPlaying(false); move(clampReplayTime(Number(position), overview)); }
  }, [position, overview, move]);
  useEffect(() => () => stepRequest.current?.abort(), []);

  const bounds = overview ? replayWindowBounds(at, overview, windowMs) : { startAt: 0, endAt: 0 };
  const activeWindow = windows.find(window => window.startAt === bounds.startAt && window.endAt === bounds.endAt);
  const currentStart = useRef(bounds.startAt);
  currentStart.current = bounds.startAt;
  const storeWindow = useCallback((next: ReplayWindow) => {
    cached.current = retainReplayWindows([...cached.current.filter(value => value.startAt !== next.startAt), next], currentStart.current);
    setWindows(cached.current);
  }, []);
  useEffect(() => {
    if (!overview || overview.endAt < overview.startAt) return;
    const controller = new AbortController();
    setWindowError("");
    const load = async (start: number, end: number, required: boolean) => {
      if (cached.current.some(window => window.startAt === start && window.endAt === end)) return;
      try {
        const result = await readWindow(scope, start, end, controller.signal);
        if (!controller.signal.aborted) storeWindow(result);
      } catch (error) {
        if (!controller.signal.aborted && required) setWindowError(String(error));
      }
    };
    void load(bounds.startAt, bounds.endAt, true);
    if (bounds.endAt < overview.endAt) void load(bounds.endAt, Math.min(bounds.endAt + windowMs, overview.endAt), false);
    return () => controller.abort();
  }, [scope, bounds.startAt, bounds.endAt, windowMs, overview, retry, storeWindow]);

  const frames = useMemo(() => mergeReplayPages(windows).frames, [windows]);
  const visibleFrames = useMemo(() => replayFramesAt(activeWindow?.frames ?? [], at, capability), [activeWindow, at, capability]);
  // Records are immutable. Keep frame identity stable while the playhead moves within one sample.
  const frameKey = JSON.stringify(visibleFrames.map(frame => [frame.id, frame.media]));
  const target = useMemo(() => activeWindow ? { key: frameKey, value: visibleFrames,
    urls: visibleFrames.flatMap(frame => frame.media.filter(media => media.mediaType.startsWith("image/") && !media.video).map(media => media.url)) } : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [frameKey, !!activeWindow]);
  const future = frames.filter(frame => frame.at > at && (!capability || frame.capability === capability)).slice(0, 2)
    .flatMap(frame => frame.media.filter(media => media.mediaType.startsWith("image/") && !media.video).map(media => media.url));
  const { displayed, pending } = useBufferedMedia(scope + ":" + capability + ":" + refresh + ":" + retry, target, future, !activeWindow || stepping);
  // Video frames share a decoder for the entire segment; advancing record metadata must not pause playback.
  const imageReady = !!activeWindow && (!target?.urls.length || !pending) && !stepping;
  const shownFrames = target && !target.urls.length ? visibleFrames : displayed?.value ?? [];
  const videoSlots = visibleFrames.flatMap(frame => frame.media.filter(media => media.video)
    .map(media => ({ slot: frame.capability + ":" + media.index, video: media.video! })));
  const slotsKey = JSON.stringify(videoSlots.map(({ slot }) => slot));
  useEffect(() => {
    const keep = new Set<string>(JSON.parse(slotsKey));
    setVideoReadiness(previous => {
      if (Object.keys(previous).every(slot => keep.has(slot))) return previous;
      return Object.fromEntries(Object.entries(previous).filter(([slot]) => keep.has(slot)));
    });
  }, [slotsKey]);
  const ready = imageReady && videoSlots.every(({ slot, video }) => video.status === "gap" || video.status === "error"
    || video.status === "ready" && videoReadiness[slot]?.url === video.url && videoReadiness[slot].ready);
  const pendingSegments = !!activeWindow?.frames.some(frame => frame.media.some(media => media.video?.status === "pending"));
  useEffect(() => {
    if (!pendingSegments || !activeWindow) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void readWindow(scope, activeWindow.startAt, activeWindow.endAt, controller.signal)
        .then(window => { if (!controller.signal.aborted) storeWindow(window); })
        .catch(error => { if (!controller.signal.aborted) setWindowError(String(error)); });
    }, 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [pendingSegments, activeWindow, scope, storeWindow]);
  useEffect(() => {
    if (!playing || !ready || !overview) return;
    let animation = 0, previous = performance.now(), lastPaint = previous;
    const tick = (now: number) => {
      const next = Math.min(overview.endAt, atRef.current + (now - previous) * speed);
      previous = now;
      atRef.current = next;
      if (now - lastPaint >= 60 || next >= overview.endAt) { setAt(next); lastPaint = now; }
      if (next >= overview.endAt) { setPlaying(false); return; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, speed, ready, overview]);

  const items = activeWindow?.items ?? [];
  const activeItems = items.filter(item => item.track !== "log" && replayItemActive(item, at));
  const logs = nearbyReplayItems(items.filter(item => item.track === "log"), at, 8);
  const capabilities = [...new Set([...(overview?.capabilities ?? []), ...frames.map(frame => frame.capability)])];
  const seek = (next: number, share = true) => {
    if (!overview) return;
    stepRequest.current?.abort(); setStepping(false); setPlaying(false);
    const value = clampReplayTime(next, overview);
    move(value);
    if (share) onPosition(Math.round(value));
  };
  const step = async (direction: -1 | 1) => {
    if (!overview) return;
    setPlaying(false); stepRequest.current?.abort();
    const nearby = adjacentReplayFrame(frames, at, direction, capability);
    if (nearby) { seek(nearby.at); return; }
    const controller = new AbortController(); stepRequest.current = controller; setStepping(true);
    try {
      let edge = direction === 1 ? bounds.endAt : bounds.startAt;
      while (direction === 1 ? edge < overview.endAt : edge > overview.startAt) {
        const target = replayWindowBounds(direction === 1 ? edge : edge - 1, overview, windowMs);
        const result = await readWindow(scope, target.startAt, target.endAt, controller.signal);
        if (controller.signal.aborted) return;
        const next = adjacentReplayFrame(result.frames, at, direction, capability);
        if (next) { move(next.at); storeWindow(result); onPosition(next.at); return; }
        edge = direction === 1 ? target.endAt : target.startAt;
      }
    } catch (error) { if (!controller.signal.aborted) setWindowError(String(error)); }
    finally { if (!controller.signal.aborted) setStepping(false); }
  };
  const selectFrame = (frame: ReplayFrame) => { seek(frame.at); setSelection({ kind: "frame", value: frame }); };
  const selectItem = (item: ReplayItem) => { seek(item.startAt); setSelection({ kind: "item", value: item }); };
  const share = async () => {
    onPosition(Math.round(at));
    const url = new URL(window.location.href);
    url.searchParams.set("view", "replay"); url.searchParams.set("at", String(Math.round(at)));
    url.searchParams.set("project", project); url.searchParams.set("run", run);
    if (epoch) url.searchParams.set("epoch", epoch);
    try { await navigator.clipboard.writeText(url.toString()); setShareState("链接已复制"); }
    catch { setShareState("已将当前时刻写入地址栏"); }
  };

  if (!project || !run) return <section className="surface empty-state"><h2>选择一段运行记录</h2><p>已有的感知、动作和模型记录会在同一条时间轴播放。</p></section>;
  if (!overview) return <section className="surface empty-state"><h2>{overviewError ? "回放暂时不可用" : "正在整理时间轴"}</h2>
    <p role={overviewError ? "alert" : "status"}>{overviewError || "从现有记录读取这段经历…"}</p>
    {overviewError && <button className="control-button" onClick={() => setRefresh(value => value + 1)}>重新读取</button>}</section>;
  const duration = overview.endAt - overview.startAt;
  const x = (time: number) => Math.max(0, Math.min(100, (time - bounds.startAt) / Math.max(1, bounds.endAt - bounds.startAt) * 100));
  const trackFrames = (activeWindow?.frames ?? []).filter(frame => frame.at >= bounds.startAt && (!capability || frame.capability === capability));
  return <div className="replay-player">
    <div className="replay-toolbar">
      <span className="replay-readonly"><i /> 历史回放 · 不操作设备</span>
      <div><button className="text-button" disabled={refreshing} onClick={() => { cached.current = []; setWindows([]); setRefresh(value => value + 1); setRetry(value => value + 1); }}>
        {refreshing ? "正在刷新…" : "刷新记录"}</button>
        <button className="text-button" onClick={share}>分享此刻 ↗</button></div>
    </div>
    {shareState && <p className="replay-notice" role="status">{shareState}</p>}
    {overviewError && <p className="error-banner" role="alert">{overviewError} · 保留已加载记录</p>}
    <section className="surface replay-stage">
      <div className="surface-heading"><h2>经历回放</h2><label className="replay-capability">感知来源
        <select aria-label="感知来源" value={capability} onChange={event => {
          stepRequest.current?.abort(); setStepping(false); setCapability(event.target.value);
        }}>
          <option value="">全部感知</option>{capabilities.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label></div>
      <div className="replay-frames" aria-busy={!ready}>
        {shownFrames.length ? shownFrames.map(frame => <article className="replay-frame" key={frame.capability} data-frame-id={frame.id}>
          <div className="replay-frame-meta"><button type="button" className="text-button" onClick={() => setSelection({ kind: "frame", value: frame })}>
            {frame.capability} · #{frame.sequence} ↗</button><span>采样 {wallTime(frame.at)}{ready ? " · " + (Math.max(0, at - frame.at) / 1000).toFixed(1) + " 秒前" : " · 上一画面"}</span></div>
          <FrameMedia key={refresh + ":" + retry} frame={frame} images={displayed?.images ?? new Map()} playback={{ at, playing: playing && ready, speed, onReady: onVideoReady }} />
        </article>) : <div className="replay-loading">{!ready ? "正在载入画面…" : "此时还没有" + (capability ? "此来源的" : "") + "感知记录"}<small>播放会按记录时间继续。</small></div>}
        {!ready && <span className="replay-buffering" role="status">{windowError ? "此段读取失败" : "正在缓冲…"}</span>}
      </div>
      {windowError && <div className="replay-window-error" role="alert">{windowError}<button className="text-button" onClick={() => setRetry(value => value + 1)}>重试此段</button></div>}
      <div className="replay-controls">
        <input className="replay-seek" type="range" min={overview.startAt} max={Math.max(overview.endAt, overview.startAt + 1)} step="1" value={at}
          disabled={duration <= 0} aria-label="回放进度" aria-valuetext={replayDuration(at - overview.startAt) + " / " + replayDuration(duration)}
          onChange={event => seek(Number(event.target.value), false)} onPointerUp={() => onPosition(Math.round(atRef.current))}
          onKeyUp={() => onPosition(Math.round(atRef.current))} />
        <div className="replay-control-row"><div className="replay-transport">
          <button type="button" className="replay-play" aria-label={playing ? "暂停回放" : "播放回放"} disabled={duration <= 0 || !!windowError}
            onClick={() => { stepRequest.current?.abort(); setStepping(false); if (at >= overview.endAt) move(overview.startAt); setPlaying(value => !value); }}>
            {playing ? "Ⅱ 暂停" : "▶ 播放"}</button>
          <button type="button" aria-label="上一采样帧" disabled={stepping || at <= overview.startAt} onClick={() => void step(-1)}>‹ 帧</button>
          <button type="button" aria-label="下一采样帧" disabled={stepping || at >= overview.endAt} onClick={() => void step(1)}>帧 ›</button>
          <span className="replay-time mono">{replayDuration(at - overview.startAt)} <small>/ {replayDuration(duration)}</small></span>
        </div><div className="replay-clock"><span className="mono">{wallTime(at)}</span>
          <select aria-label="播放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}>
            {[0.25, 0.5, 1, 2, 4, 8].map(value => <option key={value} value={value}>{value}×</option>)}
          </select></div></div>
      </div>
    </section>
    <section className="surface replay-timeline" aria-label="多轨时间轴">
      <div className="surface-heading"><h2>同一时刻，发生了什么</h2><label className="replay-window-size">时间窗
        <select aria-label="回放时间窗" value={windowMs} onChange={event => {
          stepRequest.current?.abort(); setStepping(false); cached.current = []; setWindows([]); setWindowMs(Number(event.target.value));
        }}>{[1, 5, 15, 30, 60].map(seconds => <option key={seconds} value={seconds * 1000}>{seconds} 秒</option>)}</select>
        <span className="mono">{wallTime(bounds.startAt)} — {wallTime(bounds.endAt)}</span></label></div>
      <div className="replay-track-row"><span>感知</span><div className="replay-track-lane">
        {trackFrames.map(frame => <button key={frame.id} className="replay-frame-tick" style={{ left: x(frame.at) + "%" }}
          aria-label={"查看感知 " + wallTime(frame.at)} title={frame.capability + " · " + wallTime(frame.at)} onClick={() => selectFrame(frame)} />)}
        <i className="replay-cursor" style={{ left: x(at) + "%" }} />
      </div></div>
      {replayTracks.map(track => <div key={track} className="replay-track-row"><span>{replayTrackLabels[track]}</span><div className="replay-track-lane">
        {items.filter(item => item.track === track).map(item => <button key={item.id}
          className={"replay-span " + track + (replayItemActive(item, at) ? " active" : "") + (/error|failed/.test(item.status ?? "") ? " failed" : "")}
          style={{ left: x(item.startAt) + "%", width: Math.max(0.35, x(item.endAt ?? bounds.endAt) - x(item.startAt)) + "%" }}
          title={item.label + " · " + wallTime(item.startAt)} aria-label={replayTrackLabels[track] + " · " + item.label}
          onClick={() => selectItem(item)}>{track === "log" ? "" : item.label}</button>)}
        <i className="replay-cursor" style={{ left: x(at) + "%" }} />
      </div></div>)}
      <p className="replay-axis-note">以已有记录时间对齐。点击轨道查看来源；画面沿用最近一次采样。</p>
    </section>
    <div className="replay-context-grid">
      <section className="surface replay-context"><div className="surface-heading"><h2>当前动作与调用</h2><span>{activeItems.length} 项</span></div>
        {activeItems.length ? activeItems.map(item => <button key={item.id} className="replay-context-item" onClick={() => selectItem(item)}>
          <span className={"replay-track-badge " + item.track}>{replayTrackLabels[item.track]}</span><strong>{item.label}</strong>
          <small>{statusLabel[item.status ?? ""] ?? item.status ?? (item.endAt === null ? "未记录结束" : "已记录")}</small>
        </button>) : <p className="replay-empty-context">此刻没有正在执行的动作或调用。</p>}
      </section>
      <section className="surface replay-context"><div className="surface-heading"><h2>附近日志</h2><span>点击定位与展开</span></div>
        {logs.length ? logs.map(item => <button key={item.id} className={"replay-context-item" + (item.startAt <= at ? " past" : " future")} onClick={() => selectItem(item)}>
          <time className="mono">{wallTime(item.startAt)}</time><strong>{item.label}</strong>
        </button>) : <p className="replay-empty-context">这一时间窗没有日志。</p>}
      </section>
    </div>
    {selection && <ReplayDetails key={selection.kind + ":" + selection.value.id} scope={scope} selection={selection} onClose={() => setSelection(null)} />}
  </div>;
}
