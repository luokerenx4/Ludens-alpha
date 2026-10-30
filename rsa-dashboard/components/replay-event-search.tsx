"use client";

import { useEffect, useRef, useState, type MouseEvent, type Ref } from "react";
import { Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { readArchiveJson } from "@/lib/archive-client";
import type { ReplayItem, ReplaySearchResult, ReplayTrack } from "@/lib/replay-types";
import { useTranslations } from "@/lib/locale";
import { replayElapsedInput } from "./replay-navigation";
import { useRetryFocus } from "./use-retry-focus";

type Track = "all" | ReplayTrack;
interface SearchState {
  query: string; track: Track; items: ReplayItem[]; loading: boolean; error: string;
  cursor?: string; scan?: ReplaySearchResult["scan"]; coverage?: ReplaySearchResult["coverage"];
  stopped: boolean; page: number;
}

/** Automatically scan bounded server pages, stopping at one readable result batch. */
export function ReplayEventSearch({ scope, startAt, itemUrl, onSelect, selectedId, inputId, inputRef }: {
  scope: string; startAt: number; itemUrl(item: ReplayItem): string;
  onSelect(item: ReplayItem, trigger: HTMLElement): void; selectedId?: string;
  inputId: string; inputRef: Ref<HTMLInputElement>;
}) {
  const t = useTranslations("replayNavigation"), timeline = useTranslations("timelinePlayer");
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState<Track>("all");
  const [state, setState] = useState<SearchState | null>(null);
  const focus = useRetryFocus(!!state?.loading, state?.error);
  const current = useRef<SearchState | null>(null);
  const request = useRef<AbortController | null>(null);
  const update = (next: SearchState) => { current.current = next; setState(next); };
  useEffect(() => () => request.current?.abort(), [scope]);

  const scan = async (initial: SearchState) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    let next = { ...initial, loading: true, stopped: false, error: "" };
    update(next);
    const cursors = new Set<string>();
    try {
      for (;;) {
        const params = new URLSearchParams(scope);
        params.set("mode", "search"); params.set("q", next.query); params.set("track", next.track);
        if (next.cursor) {
          if (cursors.has(next.cursor)) throw new Error(timeline("paginationStalled"));
          cursors.add(next.cursor); params.set("cursor", next.cursor);
        }
        const page = await readArchiveJson<ReplaySearchResult>(`/api/replay?${params}`, controller.signal);
        if (controller.signal.aborted || request.current !== controller) return;
        const items = [...new Map([...next.items, ...page.items].map(item => [item.id, item])).values()];
        next = { ...next, items, cursor: page.nextCursor, scan: page.scan, coverage: page.coverage };
        // Each response holds <=100 hits. A display batch holds at most199, independent of run length.
        const finished = !next.cursor || items.length >= 100;
        update({ ...next, loading: !finished });
        if (finished) return;
      }
    } catch (error) {
      if (!controller.signal.aborted && request.current === controller) update({ ...next, loading: false,
        error: error instanceof Error ? error.message : String(error) });
    } finally { if (request.current === controller) request.current = null; }
  };
  const run = () => void scan({ query: query.trim(), track, items: [], loading: true, error: "", stopped: false, page: 1 });
  const stop = () => {
    request.current?.abort(); request.current = null;
    if (current.current) update({ ...current.current, loading: false, stopped: true });
  };
  const changeQuery = (value: string) => { if (request.current) stop(); setQuery(value); };
  const changed = !!state && (state.query !== query.trim() || state.track !== track);
  const progress = state?.scan ? Math.min(100, Math.floor(state.scan.throughPosition / Math.max(1, state.scan.totalPositions) * 100)) : 0;
  const complete = !!state?.scan?.complete && !!state.coverage?.complete;
  const follow = (event: MouseEvent<HTMLAnchorElement>, item: ReplayItem) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault(); onSelect(item, event.currentTarget);
  };
  return <section className="replay-event-search space-y-4" aria-label={t("eventSearchTitle")}>
    <div><h2 className="text-sm font-semibold">{t("eventSearchTitle")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("eventSearchHint")}</p></div>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); run(); }}>
      <Label htmlFor={inputId} className="sr-only">{t("searchLabel")}</Label>
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
        <Input id={inputId} ref={inputRef} value={query} maxLength={200} className="pl-9" placeholder={t("searchPlaceholder")} onChange={event => changeQuery(event.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect size="sm" aria-label={t("trackFilter")} value={track} onChange={event => { if (request.current) stop(); setTrack(event.target.value as Track); }}>
          <NativeSelectOption value="all">{t("allTracks")}</NativeSelectOption>
          {(["action", "model", "tool", "log"] as const).map(value => <NativeSelectOption key={value} value={value}>{timeline(`track.${value}`)}</NativeSelectOption>)}
        </NativeSelect>
        <Button type="submit" size="sm" variant="outline">{t("search")}</Button>
        {state && <Button type="button" size="sm" variant="ghost" aria-disabled={!state.loading} className="aria-disabled:opacity-50"
          onClick={() => { if (state.loading) stop(); }}>{t("stopSearch")}</Button>}
      </div>
    </form>
    {!state && <p className="replay-search-empty">{t("searchInitial")}</p>}
    {state && <>
      <div ref={focus.target} tabIndex={-1} className="text-xs text-muted-foreground outline-none" role="status">
        {changed ? <p>{t("searchChanged")}</p> : null}
        <p>{state.loading ? t("searching").replace("{percent}", String(progress)) : state.stopped ? t("searchStopped")
          : state.error ? t("searchFailed") : complete ? t("searchComplete") : state.cursor ? t("moreMatches") : t("searchPartial")}</p>
        <p>{t("resultCount").replace("{count}", String(state.items.length)).replace("{page}", String(state.page))}</p>
      </div>
      {state.error && <Alert variant="destructive"><AlertDescription>
        <p>{t("searchFailed")}</p><details className="mt-2 text-xs"><summary>{t("technicalDetails")}</summary><p className="mt-2 break-all">{state.error}</p></details>
      </AlertDescription></Alert>}
      {!state.items.length && !state.loading && !state.error && !state.stopped && <p className="replay-search-empty">{t(complete ? "noResults" : "noResultsYet")}</p>}
      <ol className="replay-search-results">
        {state.items.map(item => <li key={item.id}><a href={itemUrl(item)} onClick={event => follow(event, item)}
          aria-current={item.id === selectedId ? "true" : undefined} data-replay-item={item.id}>
          <div className="replay-search-result-meta"><time className="font-mono tabular-nums">{replayElapsedInput(item.startAt - startAt, "seconds")}</time>
            <Badge variant="outline" className="whitespace-normal text-xs">{timeline(`track.${item.track}`)}</Badge>
            {item.status && <span className="replay-search-result-status">{["completed","failed","cancelled","running","success","error","pending"].includes(item.status)
              ? timeline(`status.${({success:"completed",error:"failed",pending:"pending"} as Record<string,string>)[item.status] ?? item.status}`) : item.status}</span>}
          </div>
          <p className="replay-search-result-label">{item.label}</p>
        </a></li>)}
      </ol>
      {!changed && (state.stopped || state.error) && <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={event => { focus.remember(event.currentTarget); void scan(state); }}>{t("continueSearch")}</Button>
        {state.error && <Button type="button" variant="ghost" size="sm" onClick={event => { focus.remember(event.currentTarget); void scan({ ...state, items: [], cursor: undefined, scan: undefined, coverage: undefined, page: 1 }); }}>{t("restartSearch")}</Button>}
      </div>}
      {!changed && !state.loading && !state.stopped && !state.error && state.cursor && <Button type="button" variant="outline" size="sm"
        onClick={event => { focus.remember(event.currentTarget); void scan({ ...state, items: [], page: state.page + 1 }); }}>{t("nextResults")}</Button>}
    </>}
  </section>;
}
