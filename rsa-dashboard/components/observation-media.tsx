"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/lib/locale";
import type { Observation } from "@/lib/types";
import { mediaFailureMessage } from "./observation-model";
import { useBufferedMedia } from "./use-buffered-media";
import { useRetryFocus } from "./use-retry-focus";

/** A retry reads the same recorded resource; it never executes an observation. */
export async function readObservationText(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (signal.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("Observation read failed"), { httpStatus: response.status });
  }
  const value = await response.text();
  signal.throwIfAborted();
  return value;
}

/** Status probes discard the body; audio playback remains a separate user action. */
export async function observationMediaStatus(url: string, signal: AbortSignal): Promise<number> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  await response.body?.cancel().catch(() => {});
  signal.throwIfAborted();
  return response.status;
}

function httpStatus(error: unknown): number | undefined {
  const value = (error as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof value === "number" ? value : undefined;
}

/** Key this boundary by URL so a different selection cannot inherit retry focus. */
function MediaRecovery({ kind, pending, error, onRetry, children }: {
  kind: "image" | "text" | "audio"; pending: boolean; error?: ReactNode; onRetry(): void; children: ReactNode;
}) {
  const t = useTranslations("runVisuals");
  const [retried, setRetried] = useState(false);
  const focus = useRetryFocus(pending, error ? "failed" : undefined);
  return <div ref={focus.target} className="buffered-observation" tabIndex={-1} role="region"
    aria-label={t("mediaRecovery.region")} aria-busy={pending} data-observation-media
    data-media-kind={kind} data-media-state={pending ? "loading" : error ? "error" : "ready"}
    data-media-retrying={retried && pending}>
    {error || (retried && pending) ? <div className="flex min-w-0 flex-col items-center gap-3 p-4 text-center">
      <p role="status" className="text-sm">{pending ? t("mediaRecovery.retrying") : error}</p>
      <Button type="button" variant="outline" size="sm" aria-disabled={pending} className="aria-disabled:opacity-50" onClick={event => {
        if (pending) return;
        focus.remember(event.currentTarget); setRetried(true); onRetry();
      }}>{t(pending ? "mediaRecovery.retrying" : "mediaRecovery.retry")}</Button>
      <p className="text-xs text-muted-foreground">{t("mediaRecovery.readOnly")}</p>
    </div> : children}
  </div>;
}

function TextObservation({ url }: { url: string }) {
  const t = useTranslations("runVisuals"), { t: rootT } = useLocale();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ revision: number; text?: string; failed?: boolean; httpStatus?: number } | null>(null);
  const pending = result?.revision !== revision;
  const error = !pending && result?.failed ? mediaFailureMessage(result.httpStatus ?? 0, rootT) : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void readObservationText(url, controller.signal).then(text => {
      if (!controller.signal.aborted) setResult({ revision, text });
    }).catch(cause => {
      if (!controller.signal.aborted) setResult({ revision, failed: true, httpStatus: httpStatus(cause) });
    });
    return () => controller.abort();
  }, [url, revision]);
  return <MediaRecovery kind="text" pending={pending} error={error} onRetry={() => setRevision(value => value + 1)}>
    {pending ? <span role="status">{t("textObservation.loading")}</span>
      : <pre className="observation-text m-0 h-full max-h-full w-full p-4">{result?.text}</pre>}
  </MediaRecovery>;
}

function MediaFailure({ url }: { url: string }) {
  const { t } = useLocale();
  const [status, setStatus] = useState<number | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    void observationMediaStatus(url, controller.signal).then(value => {
      if (!controller.signal.aborted) setStatus(value);
    }).catch(() => {});
    return () => controller.abort();
  }, [url]);
  return <span>{mediaFailureMessage(status ?? 0, t)}</span>;
}

function BufferedObservationImage({ url, alt }: { url: string; alt: string }) {
  const t = useTranslations("runVisuals"), { t: rootT } = useLocale();
  const [revision, setRevision] = useState(0);
  const target = useMemo(() => ({ key: url, value: alt, urls: [url] }), [url, alt]);
  // Rebuilding this viewer's buffer drops a failed same-URL entry and releases its resources.
  const { displayed, pending } = useBufferedMedia("observation:" + revision, target);
  const image = displayed?.images.get(displayed.key);
  const error = !pending && image?.error ? mediaFailureMessage(image.httpStatus ?? 0, rootT) : undefined;
  return <MediaRecovery key={url} kind="image" pending={pending} error={error} onRetry={() => setRevision(value => value + 1)}>
    {image && !image.error ? <img src={image.src} width={image.width} height={image.height} alt={displayed!.value} />
      : <span role="status">{t("buffered.loading")}</span>}
    {pending && image && !image.error && <small role="status">{t("buffered.pendingKeep")} {displayed!.value}</small>}
  </MediaRecovery>;
}

function AudioObservation({ url, alt }: { url: string; alt: string }) {
  const t = useTranslations("runVisuals"), { t: rootT } = useLocale();
  const [state, setState] = useState<{ phase: "idle" | "checking" | "failed"; httpStatus?: number }>({ phase: "idle" });
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { const active = request.current; request.current = null; active?.abort(); }, []);
  const retry = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setState({ phase: "checking" });
    try {
      const status = await observationMediaStatus(url, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      if (status >= 200 && status < 300) { setRevision(value => value + 1); setState({ phase: "idle" }); }
      else setState({ phase: "failed", httpStatus: status });
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setState({ phase: "failed", httpStatus: httpStatus(cause) ?? 0 });
    } finally { if (request.current === controller) request.current = null; }
  };
  const error = state.phase === "failed" ? state.httpStatus === undefined
    ? <MediaFailure key={url + ":" + revision} url={url} /> : mediaFailureMessage(state.httpStatus, rootT) : undefined;
  return <MediaRecovery kind="audio" pending={state.phase === "checking"} error={error} onRetry={() => void retry()}>
    <audio key={revision} controls preload="none" src={url} aria-label={alt || t("media.audio")}
      onError={() => setState({ phase: "failed" })} />
    {revision > 0 && <p role="status" className="mx-4 max-w-full text-center text-xs text-muted-foreground">{t("mediaRecovery.audioReady")}</p>}
  </MediaRecovery>;
}

export function ObservationMedia({ observation, url, alt = "", thumbnail = false }: {
  observation: Observation; url: string; alt?: string; thumbnail?: boolean;
}) {
  const t = useTranslations("runVisuals");
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (observation.mediaStorage === "unrecorded") return <span>{t("media.unrecorded")}</span>;
  if (observation.mediaType.startsWith("image/")) {
    if (!thumbnail) return <BufferedObservationImage url={url} alt={alt} />;
    return failedUrl === url ? <span role="status"><MediaFailure key={url} url={url} /></span>
      : <img src={url} alt={alt} onError={() => setFailedUrl(url)} />;
  }
  if (thumbnail) return <span>{observation.mediaType.startsWith("audio/") ? t("media.audio") : t("media.text")}</span>;
  if (observation.mediaType.startsWith("audio/")) return <AudioObservation key={url} url={url} alt={alt} />;
  return <TextObservation key={url} url={url} />;
}
