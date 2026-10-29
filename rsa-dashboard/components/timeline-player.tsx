"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { ReplayDetail, ReplayFrame, ReplayItem, ReplayOverview, ReplayOverviewResult, ReplayCoverage, ReplayWindow } from "../lib/replay-types";
import { adjacentReplayFrame, clampReplayTime, mergeReplayPages, nearbyReplayItems, REPLAY_WINDOW_MS,
  replayDuration, replayFramesAt, replayItemActive, replayTracks, replayWindowBounds,
  retainReplayWindows } from "./replay-model";
import { useBufferedMedia } from "./use-buffered-media";
import type { BufferedImage } from "./image-buffer";
import { ReplayVideo } from "./replay-video";
import { replayVideoReady } from "./replay-video-model";
import { readArchiveJson } from "../lib/archive-client";
import "./timeline-player.css";
import { useTranslations } from "@/lib/locale";

const read = readArchiveJson;

const endpoint = (scope: string, params: Record<string, string | number>) =>
  "/api/replay?" + scope + "&" + new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));

async function readWindow(scope: string, start: number, end: number, signal: AbortSignal,
  mode: "frames" | "events" = "frames", onPage?: (page: ReplayWindow) => void, initial?: ReplayWindow,
  stalledMessage = "Replay pagination stalled; please retry") {
  const pages: ReplayWindow[] = initial ? [initial] : [], cursors = new Set<string>();
  let cursor = initial?.nextCursor;
  for (let n = 0; n < 10; n++) {
    const page = await read<ReplayWindow>(endpoint(scope, { mode, start, end, ...(cursor ? { cursor } : {}) }), signal);
    pages.push(page);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const merged = mergeReplayPages(pages);
    // History remains accessible through the cursor; the browser keeps a bounded working page.
    merged.frames = merged.frames.slice(-5000); merged.items = merged.items.slice(-5000);
    onPage?.(merged);
    cursor = page.nextCursor;
    if (!cursor) return merged;
    if (cursors.has(cursor)) throw new Error(stalledMessage);
    cursors.add(cursor);
    pages.splice(0, pages.length, merged);
  }
  return mergeReplayPages(pages);
}

const wallTime = (at: number) => new Date(at).toLocaleTimeString("zh-CN", {
  hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
});
const statusKey: Record<string, string> = { completed: "completed", success: "completed", error: "failed", failed: "failed",
  cancelled: "cancelled", pending: "running", running: "running" };

type VideoPlayback = { at: number; playing: boolean; clockReady: boolean; speed: number; onReady(slot: string, url: string, ready: boolean): void };
function ReplayMedia({ media, label, sampledAt, image, playback, slot }: { media: ReplayFrame["media"][number]; label: string; image?: BufferedImage;
  sampledAt: number; playback: VideoPlayback; slot: string }) {
  const t = useTranslations("timelinePlayer");
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
      if (!response.ok) throw new Error(response.status === 410 ? t("recordExpired") : t("recordUnreadable"));
      const value = await response.text();
      if (!controller.signal.aborted) setText(value);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [media.url, isText]);
  if (media.video) return <ReplayVideo source={media.video} sampledAt={sampledAt} {...playback} slot={slot} label={label} />;
  if (image?.error || error) return <div className="replay-media-missing" role="status">{image?.error || error}<small>{t("mediaKeepPosition")}</small></div>;
  if (media.mediaType.startsWith("image/")) return <img src={image?.src} width={image?.width} height={image?.height} alt={label} draggable={false}
    onError={() => setError(t("imageUnavailable"))} />;
  if (media.mediaType.startsWith("audio/")) return <audio controls preload="none" src={media.url}
    aria-label={label} onError={() => setError(t("audioUnavailable"))} />;
  if (media.mediaType.startsWith("video/")) return <video controls preload="metadata" src={media.url}
    aria-label={label} onError={() => setError(t("videoUnavailable"))} />;
  if (isText) return <pre>{text || t("readingText")}</pre>;
  return <a href={media.url} target="_blank" rel="noreferrer">{t("view")} {media.mediaType} {t("record")} ↗</a>;
}

const FrameMedia = memo(function FrameMedia({ frame, images, playback }: {
  frame: ReplayFrame; images: Map<string, BufferedImage>; playback: VideoPlayback;
}) {
  const t = useTranslations("timelinePlayer");
  return <><div className="replay-media-grid">
    {frame.media.map(media => <div className={"replay-media" + (media.mediaType.startsWith("image/") ? " replay-image" : "")} key={media.index}>
      <ReplayMedia media={media} sampledAt={frame.at} image={images.get(media.url)} playback={playback} slot={frame.capability + ":" + media.index}
        label={frame.capability + " · " + wallTime(frame.at) + " · " + (media.index + 1)} />
    </div>)}
    {!frame.media.length && <p className="replay-no-media">{t("noMedia")}</p>}
    {frame.text && <details className="replay-frame-text"><summary>{t("frameText")}</summary><pre>{frame.text}</pre></details>}
  </div>
  </>;
});

type Selection = { kind: "frame"; value: ReplayFrame } | { kind: "item"; value: ReplayItem };

function ReplayDetails({ scope, selection, onClose }: { scope: string; selection: Selection; onClose(): void }) {
  const t = useTranslations("timelinePlayer");
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
  return <section className="surface replay-detail" aria-label={t("detailsAria")}>
    <div className="surface-heading"><h2>{detail?.title ?? t("detailsTitle")}</h2>
      <Button type="button" variant="ghost" size="xs" onClick={onClose}>{t("closeDetails")}</Button></div>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : !detail ? <p role="status">{t("readingRecord")}</p> : <>
      {!!detail.observations?.length && <div className="replay-inputs"><h3>{t("modelObservations")}</h3>
        {detail.observations.map(observation => <div key={observation.id}>
          {observation.url ? <img src={observation.url} alt={t("modelInput") + " " + observation.id} loading="lazy" /> : <span>{t("unrecordedMedia")}</span>}
          <small>{observation.recordId ?? observation.id}{observation.sequence ? " · #" + observation.sequence : ""}
            {observation.approximate ? t("approximateNote") : ""}</small>
        </div>)}
      </div>}
      <pre>{JSON.stringify(detail.data, null, 2)}</pre>
    </>}
  </section>;
}

export function TimelinePlayer({ project, run, epoch, position, onPosition, onOverview, archiveRevision }: {
  project: string; run: string; epoch?: string; position?: string | null; onPosition(at: number): void;
  onOverview?(value: ReplayOverviewResult): void;
  archiveRevision?: number;
}) {
  const t = useTranslations("timelinePlayer");
  const controlsId = useId();
  const requestedScope = new URLSearchParams({ project, run, ...(epoch ? { epoch } : {}) }).toString();
  const [overview, setOverview] = useState<ReplayOverview | null>(null);
  const resolvedEpoch = overview ? overview.epoch : epoch;
  const scope = new URLSearchParams({ project, run, ...(resolvedEpoch ? { epoch: resolvedEpoch } : {}) }).toString();
  const [coverage, setCoverage] = useState<ReplayCoverage | null>(null);
  const [eventWindow, setEventWindow] = useState<ReplayWindow | null>(null);
  const [eventError, setEventError] = useState("");
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventPage, setEventPage] = useState(0);
  const [overviewError, setOverviewError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [overviewPoll, setOverviewPoll] = useState(0);
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
  const previousEpoch = useRef<string | null>(null);
  const positionApplied = useRef<string | null | undefined>(undefined);
  const move = useCallback((next: number) => { atRef.current = next; setAt(next); }, []);

  useEffect(() => {
    if (!project || !run) return;
    const controller = new AbortController();
    setRefreshing(true); setOverviewError("");
    void read<ReplayOverviewResult>(endpoint(requestedScope, { mode: "overview" }), controller.signal).then(next => {
      if (controller.signal.aborted) return;
      onOverview?.(next);
      setCoverage(next.coverage ?? null);
      if (next.startAt === null) return;
      if (hasOverview.current && previousEpoch.current !== next.epoch) {
        setWindows([]); setEventWindow(null); setSelection(null); setPlaying(false);
        move(next.startAt);
      }
      previousEpoch.current = next.epoch;
      if (!hasOverview.current) {
        hasOverview.current = true;
        move(clampReplayTime(Number(initialPosition.current ?? next.startAt), next));
      }
      setOverview(next);
    }).catch(error => { if (!controller.signal.aborted) setOverviewError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [requestedScope, project, run, refresh, overviewPoll, move, onOverview, archiveRevision]);

  useEffect(() => {
    if (!coverage || coverage.complete || overviewError) return;
    const timer = setTimeout(() => setOverviewPoll(value => value + 1), 750);
    return () => clearTimeout(timer);
  }, [coverage, overviewError]);

  useEffect(() => {
    if (!overview || position === positionApplied.current) return;
    positionApplied.current = position;
    if (position != null) { setPlaying(false); move(clampReplayTime(Number(position), overview)); }
  }, [position, overview, move]);
  useEffect(() => () => stepRequest.current?.abort(), []);

  const bounds = overview ? replayWindowBounds(at, overview, windowMs) : { startAt: 0, endAt: 0 };
  const activeWindow = windows.find(window => window.startAt === bounds.startAt && window.endAt === bounds.endAt);
  const frameLoads = useRef(new Map<string, AbortController>());
  const [framePass, setFramePass] = useState(0);
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
      const key = `${start}:${end}`;
      frameLoads.current.set(key, controller);
      try {
        const result = await readWindow(scope, start, end, controller.signal, "frames", page => {
          if (!controller.signal.aborted) storeWindow(page);
        });
        if (!controller.signal.aborted) storeWindow(result);
      } catch (error) {
        if (!controller.signal.aborted && required) setWindowError(String(error));
      } finally {
        if (frameLoads.current.get(key) === controller) frameLoads.current.delete(key);
        setFramePass(value => value + 1);
      }
    };
    void load(bounds.startAt, bounds.endAt, true);
    if (bounds.endAt < overview.endAt) void load(bounds.endAt, Math.min(bounds.endAt + windowMs, overview.endAt), false);
    return () => controller.abort();
  }, [scope, bounds.startAt, bounds.endAt, windowMs, overview?.startAt, overview?.endAt, retry, storeWindow]);

  useEffect(() => {
    if (!overview) return;
    const controller = new AbortController();
    setEventError(""); setEventsLoading(true);
    const prior = eventWindow?.startAt === bounds.startAt && eventWindow.endAt === bounds.endAt && eventPage ? eventWindow : undefined;
    if (!prior) setEventWindow(null);
    void readWindow(scope, bounds.startAt, bounds.endAt, controller.signal, "events", page => {
      if (!controller.signal.aborted) setEventWindow(page);
    }, prior).catch(error => { if (!controller.signal.aborted) setEventError(String(error)); })
      .finally(() => { if (!controller.signal.aborted) setEventsLoading(false); });
    return () => controller.abort();
    // Events have their own cursor and never gate frame readiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, bounds.startAt, bounds.endAt, eventPage, retry, overview?.coverage?.complete, archiveRevision]);

  const moreFrameRequest = useRef<AbortController | null>(null);
  const frameTail = activeWindow?.frames.at(-1)?.at;
  const needsFrames = !!activeWindow?.nextCursor && frameTail !== undefined && at >= frameTail - 1000;
  useEffect(() => {
    if (!needsFrames || !activeWindow || frameLoads.current.has(`${activeWindow.startAt}:${activeWindow.endAt}`)) return;
    const controller = new AbortController(); moreFrameRequest.current = controller;
    void readWindow(scope, activeWindow.startAt, activeWindow.endAt, controller.signal, "frames", undefined, activeWindow)
      .then(page => { if (!controller.signal.aborted) storeWindow(page); })
      .catch(error => { if (!controller.signal.aborted) setWindowError(String(error)); });
    return () => { controller.abort(); moreFrameRequest.current = null; };
    // A new buffered tail schedules the next page only when the playhead approaches it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, needsFrames, bounds.startAt, activeWindow?.nextCursor, storeWindow, framePass]);

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
  const imageReady = !!activeWindow && (!activeWindow.nextCursor || frameTail === undefined || at <= frameTail) && (!target?.urls.length || !pending) && !stepping;
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
  const ready = imageReady && videoSlots.every(({ slot, video }) => replayVideoReady(video, videoReadiness[slot]));
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

  const items = eventWindow?.startAt === bounds.startAt && eventWindow.endAt === bounds.endAt ? eventWindow.items : [];
  const activeItems = items.filter(item => item.track !== "log" && replayItemActive(item, at));
  const logs = nearbyReplayItems(items.filter(item => item.track === "log"), at, 8);
  const capabilities = [...new Set([...(overview?.capabilities ?? []), ...frames.map(frame => frame.capability)])];
  const seek = (next: number, share = true) => {
    if (!overview) return;
    stepRequest.current?.abort(); moreFrameRequest.current?.abort(); setStepping(false); setPlaying(false);
    const value = clampReplayTime(next, overview);
    if (activeWindow?.nextCursor && value < (activeWindow.frames[0]?.at ?? value)) {
      cached.current = []; setWindows([]); setRetry(current => current + 1);
    }
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
    url.searchParams.set("epoch", overview?.epoch ?? "all");
    try { await navigator.clipboard.writeText(url.toString()); setShareState(t("linkCopied")); }
    catch { setShareState(t("timeInUrl")); }
  };

  if (!project || !run) return <section className="surface empty-state"><h2>{t("emptyTitle")}</h2><p>{t("emptyDescription")}</p></section>;
  if (!overview) return <section className="surface empty-state"><h2>{overviewError ? t("unavailable") : t("preparing")}</h2>
    {overviewError ? <Alert variant="destructive"><AlertDescription>{overviewError}</AlertDescription></Alert>
      : <p role="status">{coverage ? <>{t("readingSourceDir")} {Math.round(coverage.bytes / Math.max(1, coverage.totalBytes) * 100)}% · {t("loadIndependent")}</> : t("readingFromRecords")}</p>}
    {overviewError && <Button type="button" variant="outline" size="sm" onClick={() => setRefresh(value => value + 1)}>{t("retryLoad")}</Button>}</section>;
  const duration = overview.endAt - overview.startAt;
  const x = (time: number) => Math.max(0, Math.min(100, (time - bounds.startAt) / Math.max(1, bounds.endAt - bounds.startAt) * 100));
  const trackFrames = (activeWindow?.frames ?? []).filter(frame => frame.at >= bounds.startAt && (!capability || frame.capability === capability));
  return <div className="replay-player">
    <div className="replay-toolbar">
      <span className="replay-readonly"><i /> {t("readonlyNotice")}</span>
      <div><Button type="button" variant="ghost" size="xs" disabled={refreshing} onClick={() => { cached.current = []; setWindows([]); setRefresh(value => value + 1); setRetry(value => value + 1); }}>
        {refreshing ? t("refreshing") : t("refreshRecords")}</Button>
        <Button type="button" variant="ghost" size="xs" onClick={share}>{t("shareMoment")}</Button></div>
    </div>
    {coverage && !coverage.complete && <p className="replay-notice" role="status">{t("coverageReadPrefix")} {Math.round(coverage.bytes / Math.max(1, coverage.totalBytes) * 100)}%{t("coverageReadSuffix")}</p>}
    {shareState && <p className="replay-notice" role="status">{shareState}</p>}
    {overviewError && <Alert variant="destructive"><AlertDescription>{overviewError}{t("keepLoaded")}</AlertDescription></Alert>}
    <section className="surface replay-stage">
      <div className="surface-heading"><h2>{t("stageTitle")}</h2><div className="replay-capability">
        <Label htmlFor={`${controlsId}-capability`} className="text-xs font-normal">{t("capabilityLabel")}</Label>
        <NativeSelect id={`${controlsId}-capability`} size="sm" className="max-w-[260px] text-xs max-[620px]:max-w-[180px]" value={capability} onChange={event => {
          stepRequest.current?.abort(); setStepping(false); setCapability(event.target.value);
        }}>
          <NativeSelectOption value="">{t("allCapabilities")}</NativeSelectOption>{capabilities.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
        </NativeSelect></div></div>
      <div className="replay-frames" aria-busy={!ready}>
        {shownFrames.length ? shownFrames.map(frame => <article className="replay-frame" key={frame.capability} data-frame-id={frame.id}>
          <div className="replay-frame-meta"><Button type="button" variant="ghost" size="xs" onClick={() => setSelection({ kind: "frame", value: frame })}>
            {frame.capability} · #{frame.sequence} ↗</Button><span>{t("sampled")} {wallTime(frame.at)}{ready ? " · " + (Math.max(0, at - frame.at) / 1000).toFixed(1) + " " + t("secondsAgo") : t("previousFrame")}</span></div>
          <FrameMedia key={refresh + ":" + retry} frame={frame} images={displayed?.images ?? new Map()} playback={{ at, playing, clockReady: ready, speed, onReady: onVideoReady }} />
        </article>) : <div className="replay-loading">{!ready ? t("loadingFrames") : capability ? t("noFramesFiltered") : t("noFramesAll")}<small>{t("playbackContinues")}</small></div>}
        {!ready && <span className="replay-buffering" role="status">{windowError ? t("segmentFailed") : t("buffering")}</span>}
      </div>
      {windowError && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{windowError}</span><Button type="button" variant="outline" size="xs" onClick={() => setRetry(value => value + 1)}>{t("retrySegment")}</Button>
      </AlertDescription></Alert>}
      <div className="replay-controls">
        {/* The media scrubber keeps native pointer/key commit semantics and millisecond steps. */}
        <input className="replay-seek accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" type="range" min={overview.startAt} max={Math.max(overview.endAt, overview.startAt + 1)} step="1" value={at}
          disabled={duration <= 0} aria-label={t("seekLabel")} aria-valuetext={replayDuration(at - overview.startAt) + " / " + replayDuration(duration)}
          onChange={event => seek(Number(event.target.value), false)} onPointerUp={() => onPosition(Math.round(atRef.current))}
          onKeyUp={() => onPosition(Math.round(atRef.current))} />
        <div className="replay-control-row"><div className="replay-transport">
          <Button type="button" size="sm" className="min-w-[90px]" aria-label={playing ? t("pauseReplay") : t("playReplay")} disabled={duration <= 0 || !!windowError}
            onClick={() => { stepRequest.current?.abort(); setStepping(false); if (at >= overview.endAt) move(overview.startAt); setPlaying(value => !value); }}>
            {playing ? t("pause") : t("play")}</Button>
          <Button type="button" variant="outline" size="sm" aria-label={t("prevFrame")} disabled={stepping || at <= overview.startAt} onClick={() => void step(-1)}>{t("prevFrameShort")}</Button>
          <Button type="button" variant="outline" size="sm" aria-label={t("nextFrame")} disabled={stepping || at >= overview.endAt} onClick={() => void step(1)}>{t("nextFrameShort")}</Button>
          <span className="replay-time mono">{replayDuration(at - overview.startAt)} <small>/ {replayDuration(duration)}</small></span>
        </div><div className="replay-clock"><span className="mono">{wallTime(at)}</span>
          <NativeSelect size="sm" aria-label={t("speedLabel")} value={speed} onChange={event => setSpeed(Number(event.target.value))}>
            {[0.25, 0.5, 1, 2, 4, 8].map(value => <NativeSelectOption key={value} value={value}>{value}×</NativeSelectOption>)}
          </NativeSelect></div></div>
      </div>
    </section>
    <section className="surface replay-timeline" aria-label={t("timelineLabel")}>
      <div className="surface-heading"><h2>{t("timelineTitle")}</h2><div className="replay-window-size">
        <Label htmlFor={`${controlsId}-window`} className="text-xs font-normal">{t("windowLabel")}</Label>
        <NativeSelect id={`${controlsId}-window`} size="sm" className="text-xs" aria-label={t("windowSelectLabel")} value={windowMs} onChange={event => {
          stepRequest.current?.abort(); setStepping(false); cached.current = []; setWindows([]); setWindowMs(Number(event.target.value));
        }}>{[1, 5, 15, 30, 60].map(seconds => <NativeSelectOption key={seconds} value={seconds * 1000}>{seconds} {t("seconds")}</NativeSelectOption>)}</NativeSelect>
        <span className="mono">{wallTime(bounds.startAt)} — {wallTime(bounds.endAt)}</span></div></div>
      <div className="replay-track-row"><span>{t("track.perception")}</span><div className="replay-track-lane">
        {trackFrames.map(frame => <button type="button" key={frame.id} className="replay-frame-tick focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring" style={{ left: x(frame.at) + "%" }}
          aria-label={t("viewPerception") + " " + wallTime(frame.at)} title={frame.capability + " · " + wallTime(frame.at)} onClick={() => selectFrame(frame)} />)}
        <i className="replay-cursor" style={{ left: x(at) + "%" }} />
      </div></div>
      {replayTracks.map(track => <div key={track} className="replay-track-row"><span>{t(`track.${track}`)}</span><div className="replay-track-lane">
        {items.filter(item => item.track === track).map(item => <button type="button" key={item.id}
          className={"replay-span focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring " + track + (replayItemActive(item, at) ? " active" : "") + (/error|failed/.test(item.status ?? "") ? " failed" : "")}
          style={{ left: x(item.startAt) + "%", width: Math.max(0.35, x(item.endAt ?? bounds.endAt) - x(item.startAt)) + "%" }}
          title={item.label + " · " + wallTime(item.startAt)} aria-label={t(`track.${track}`) + " · " + item.label}
          onClick={() => selectItem(item)}>{track === "log" ? "" : item.label}</button>)}
        <i className="replay-cursor" style={{ left: x(at) + "%" }} />
      </div></div>)}
      {eventError && <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{t("eventTrackPrefix")}{eventError}{t("videoContinues")}</span><Button type="button" variant="outline" size="xs" onClick={() => setEventPage(value => value + 1)}>{t("retry")}</Button>
      </AlertDescription></Alert>}
      {eventsLoading && <p role="status">{t("supplementingEvents")}</p>}
      {eventWindow?.nextCursor && !eventsLoading && <Button type="button" variant="ghost" size="xs" onClick={() => setEventPage(value => value + 1)}>{t("continueEvents")}</Button>}
      <p className="replay-axis-note">{t("axisNote")}</p>
    </section>
    <div className="replay-context-grid">
      <section className="surface replay-context"><div className="surface-heading"><h2>{t("currentActions")}</h2><span>{activeItems.length} {t("items")}</span></div>
        {activeItems.length ? activeItems.map(item => <button type="button" key={item.id} className="replay-context-item focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" onClick={() => selectItem(item)}>
          <span className={"replay-track-badge " + item.track}>{t(`track.${item.track}`)}</span><strong>{item.label}</strong>
          <small>{item.status && statusKey[item.status] ? t(`status.${statusKey[item.status]}`) : (item.status ?? (item.endAt === null ? t("status.notEnded") : t("status.recorded")))}</small>
        </button>) : <p className="replay-empty-context">{t("noActiveItems")}</p>}
      </section>
      <section className="surface replay-context"><div className="surface-heading"><h2>{t("nearbyLogs")}</h2><span>{t("clickToLocate")}</span></div>
        {logs.length ? logs.map(item => <button type="button" key={item.id} className={"replay-context-item focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" + (item.startAt <= at ? " past" : " future")} onClick={() => selectItem(item)}>
          <time className="mono">{wallTime(item.startAt)}</time><strong>{item.label}</strong>
        </button>) : <p className="replay-empty-context">{t("noLogs")}</p>}
      </section>
    </div>
    {selection && <ReplayDetails key={selection.kind + ":" + selection.value.id} scope={scope} selection={selection} onClose={() => setSelection(null)} />}
  </div>;
}
