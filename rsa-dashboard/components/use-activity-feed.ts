"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIVITY_LIVE_SIZE, ACTIVITY_PAGE_SIZE, ACTIVITY_WINDOW_SIZE,
  acceptsScope, mergeActivity, newerBlock, sameScope,
  type ActivityBlock, type ActivityFilter, type ActivityScope,
} from "./activity-feed-model";

import { ActivityChangesClient, requestActivity } from "../lib/activity-client";
import { ReadPoller } from "../lib/read-poller";
import { useTranslations } from "../lib/locale";

interface FeedState {
  resetRevision: number;
  loadedRevision: number | null;
  scope: ActivityScope | null;
  generation: string | null;
  snapshot: number;
  blocks: ActivityBlock[];
  selected?: ActivityBlock;
  selectionReady: boolean;
  before: string | null;
  hasMore: boolean;
  total: number;
  historical: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string;
}

const emptyState = (resetRevision = 0): FeedState => ({ resetRevision, loadedRevision: null, scope: null, generation: null, snapshot: 0,
  blocks: [], selectionReady: false, before: null, hasMore: false, total: 0,
  historical: false, loading: true, loadingOlder: false, error: "" });

const scopeParams = (scope: ActivityScope) => new URLSearchParams({ project: scope.project, run: scope.runId ?? "",
  ...(scope.epoch ? { epoch: scope.epoch } : {}) });

export function useActivityFeed(options: {
  project: string; run: string; epoch?: string; enabled: boolean; refresh: boolean; selectedBlock?: string; archiveRevision?: number;
  /** A global return-to-current action clears every log filter and obtains a fresh snapshot. */
  resetRevision?: number;
}) {
  const { project, run, epoch, enabled, refresh, selectedBlock, archiveRevision, resetRevision = 0 } = options;
  const t = useTranslations("activityFeed");
  const scopeChangedError = useRef(t("scopeChangedError"));
  scopeChangedError.current = t("scopeChangedError");
  const [filters, setFilters] = useState({ revision: resetRevision, filter: "all" as ActivityFilter, query: "" });
  const activeFilters = filters.revision === resetRevision ? filters : { revision: resetRevision, filter: "all" as ActivityFilter, query: "" };
  const { filter, query } = activeFilters;
  const [debounced, setDebounced] = useState({ revision: resetRevision, query: "" });
  const search = debounced.revision === resetRevision ? debounced.query : "";
  const setFilter = (value: ActivityFilter) => setFilters(previous => ({
    ...(previous.revision === resetRevision ? previous : { revision: resetRevision, filter: "all" as ActivityFilter, query: "" }), filter: value,
  }));
  const setQuery = (value: string) => setFilters(previous => ({
    ...(previous.revision === resetRevision ? previous : { revision: resetRevision, filter: "all" as ActivityFilter, query: "" }), query: value,
  }));
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<FeedState>(() => emptyState(resetRevision));
  const current = useRef(state);
  const selection = useRef(selectedBlock);
  selection.current = selectedBlock;
  const criteria = useRef({ filter, query: search });
  criteria.current = { filter, query: search };
  const historyRequest = useRef<AbortController | null>(null);
  const selectionRequest = useRef<AbortController | null>(null);
  const historyLoading = useRef(false);
  const poller = useRef<ReadPoller | null>(null);
  const automatic = useRef(refresh);
  automatic.current = refresh;
  // Archive completion is automatic; defer it while viewing a paused snapshot.
  const followedArchive = useRef(archiveRevision);
  if (refresh) followedArchive.current = archiveRevision;
  const activeArchiveRevision = followedArchive.current;
  const update = useCallback((change: (previous: FeedState) => FeedState) => {
    current.current = change(current.current);
    setState(current.current);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ revision: resetRevision, query: query.trim() }), 200);
    return () => clearTimeout(timer);
  }, [query, resetRevision]);

  // This stream starts with only the selected run identity, independently of /api/run.
  useEffect(() => {
    update(() => emptyState(resetRevision));
    if (!enabled || !project || !run) return;
    const reader = new ActivityChangesClient({ project, run, epoch, limit: ACTIVITY_PAGE_SIZE });
    const active = new ReadPoller(async signal => {
      let more = false;
      try {
        const result = await reader.read(signal);
        if (signal.aborted) return 2500;
        more = result.hasMore;
        const previous = current.current;
        const reset = result.mode === "snapshot" || !sameScope(previous.scope, result.scope)
          || previous.generation !== result.projection.generation;
        const merged = mergeActivity(reset ? [] : previous.blocks, result.blocks, {
          ...criteria.current, append: reset || !previous.historical,
          keep: previous.historical && !reset ? "oldest" : "latest", limit: ACTIVITY_WINDOW_SIZE,
        });
        update(value => ({ ...(reset ? emptyState(resetRevision) : value), scope: reset ? result.scope : value.scope,
          generation: result.projection.generation, snapshot: value.snapshot + (reset ? 1 : 0),
          blocks: merged, error: "",
          ...(selection.current ? {
            selected: result.blocks.filter(block => block.id === selection.current).reduce<ActivityBlock | undefined>(
              (block, next) => newerBlock(block, next), reset ? undefined : value.selected),
          } : {}),
        }));
        result.acknowledge();
        // Refresh the bounded latest page before its opaque history cursor becomes detached.
        if (!reset && !previous.historical && merged.length > ACTIVITY_LIVE_SIZE && !historyLoading.current)
          setReload(value => value + 1);
      } catch (error) {
        if (!signal.aborted) update(value => ({ ...value, loading: false, error: String(error) }));
      }
      return more ? 0 : 2500;
    }, automatic.current);
    poller.current = active;
    void active.readOnce();
    return () => {
      active.dispose();
      if (poller.current === active) poller.current = null;
      historyRequest.current?.abort();
      selectionRequest.current?.abort();
      historyLoading.current = false;
    };
  }, [project, run, epoch, enabled, activeArchiveRevision, resetRevision, update]);

  useEffect(() => { poller.current?.setEnabled(refresh); }, [refresh]);

  const scope = state.scope;
  const generation = state.generation;

  // The server owns search and pagination. Only a bounded window stays in the browser.
  useEffect(() => {
    if (!enabled || !scope || !acceptsScope(scope, project, run, epoch)
      || !sameScope(scope, current.current.scope) || generation !== current.current.generation) return;
    const controller = new AbortController();
    historyRequest.current?.abort();
    historyRequest.current = controller;
    historyLoading.current = true;
    const isCurrentRequest = () => !controller.signal.aborted && historyRequest.current === controller
      && sameScope(scope, current.current.scope) && generation === current.current.generation;
    update(value => ({ ...value, loading: true, loadingOlder: false, error: "" }));
    const params = scopeParams(scope);
    params.set("mode", "history"); params.set("kind", filter); params.set("q", search);
    params.set("limit", String(ACTIVITY_PAGE_SIZE));
    void requestActivity(params, controller.signal).then(result => {
      if (!isCurrentRequest()) return;
      if (!sameScope(result.scope, scope) || result.projection.generation !== generation) {
        update(value => ({ ...value, loading: false, error: scopeChangedError.current }));
        return;
      }
      update(value => ({ ...value, blocks: mergeActivity(result.blocks,
        value.blocks.filter(block => block.revision > result.projection.revision || block.status === "running"), {
          filter, query: search, append: true, keep: "latest", limit: ACTIVITY_WINDOW_SIZE,
        }), before: result.before ?? null, hasMore: result.hasMore, total: result.total ?? 0,
        historical: false, loading: false, loadedRevision: value.resetRevision, error: "" }));
    }).catch(error => {
      if (isCurrentRequest()) update(value => ({ ...value, loading: false, error: String(error) }));
    }).finally(() => {
      if (historyRequest.current === controller) historyLoading.current = false;
    });
    return () => controller.abort();
  }, [enabled, project, run, epoch, scope, generation, state.snapshot, filter, search, reload, update]);

  useEffect(() => {
    update(value => ({ ...value, selected: undefined, selectionReady: false }));
    if (!enabled || !scope || !selectedBlock || !acceptsScope(scope, project, run, epoch)
      || !sameScope(scope, current.current.scope) || generation !== current.current.generation) return;
    const controller = new AbortController();
    selectionRequest.current = controller;
    const isCurrentRequest = () => !controller.signal.aborted && selectionRequest.current === controller
      && sameScope(scope, current.current.scope) && generation === current.current.generation;
    const params = scopeParams(scope);
    params.set("mode", "block"); params.set("id", selectedBlock);
    void requestActivity(params, controller.signal).then(result => {
      if (!isCurrentRequest()) return;
      if (!sameScope(result.scope, scope) || result.projection.generation !== generation) {
        update(value => ({ ...value, selectionReady: true, error: scopeChangedError.current }));
        return;
      }
      update(value => ({ ...value, selected: result.blocks[0]
        ? newerBlock(value.blocks.find(block => block.id === selectedBlock) ??
          (value.selected?.id === selectedBlock ? value.selected : undefined), result.blocks[0]) : undefined,
        selectionReady: true }));
    }).catch(error => {
      if (isCurrentRequest()) update(value => ({ ...value, selectionReady: true, error: String(error) }));
    });
    return () => {
      controller.abort();
      if (selectionRequest.current === controller) selectionRequest.current = null;
    };
  }, [enabled, project, run, epoch, scope, generation, selectedBlock, update]);

  const earlier = useCallback(async () => {
    const previous = current.current;
    if (!previous.scope || !previous.before || historyLoading.current) return;
    const controller = new AbortController();
    historyRequest.current?.abort(); historyRequest.current = controller; historyLoading.current = true;
    const isCurrentRequest = () => !controller.signal.aborted && historyRequest.current === controller
      && sameScope(previous.scope, current.current.scope) && previous.generation === current.current.generation;
    update(value => ({ ...value, loadingOlder: true, error: "" }));
    const params = scopeParams(previous.scope);
    params.set("mode", "history"); params.set("kind", filter); params.set("q", search);
    params.set("before", previous.before); params.set("limit", String(ACTIVITY_PAGE_SIZE));
    try {
      const result = await requestActivity(params, controller.signal);
      if (!isCurrentRequest()) return;
      if (!sameScope(result.scope, previous.scope) || result.projection.generation !== previous.generation) {
        update(value => ({ ...value, loadingOlder: false, error: scopeChangedError.current }));
        return;
      }
      update(value => ({ ...value, blocks: mergeActivity(value.blocks, result.blocks, {
        filter, query: search, append: true, keep: "oldest", limit: ACTIVITY_WINDOW_SIZE,
      }), before: result.before ?? null, hasMore: result.hasMore, total: result.total ?? value.total,
        historical: true, loadingOlder: false }));
    } catch (error) {
      if (isCurrentRequest()) update(value => ({ ...value, loadingOlder: false, error: String(error) }));
    } finally {
      if (historyRequest.current === controller) historyLoading.current = false;
    }
  }, [filter, search, update]);

  const currentRevision = state.resetRevision === resetRevision;
  const valid = currentRevision && scope && acceptsScope(scope, project, run, epoch);
  return { ...state, loading: !currentRevision || state.loading || (!valid && !state.error),
    error: currentRevision ? state.error : "", blocks: valid ? state.blocks : [], selected: valid ? state.selected : undefined,
    filter, query, setFilter, setQuery, earlier, resetRevision, latest: () => setReload(value => value + 1) };
}

export type ActivityFeedData = ReturnType<typeof useActivityFeed>;
