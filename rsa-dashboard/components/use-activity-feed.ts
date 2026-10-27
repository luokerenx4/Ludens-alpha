"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIVITY_LIVE_SIZE, ACTIVITY_PAGE_SIZE, ACTIVITY_WINDOW_SIZE,
  acceptsScope, mergeActivity, newerBlock, sameScope,
  type ActivityBlock, type ActivityFilter, type ActivityScope,
} from "./activity-feed-model";

import { ActivityChangesClient, requestActivity } from "../lib/activity-client";

interface FeedState {
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

const emptyState = (): FeedState => ({ scope: null, generation: null, snapshot: 0,
  blocks: [], selectionReady: false, before: null, hasMore: false, total: 0,
  historical: false, loading: true, loadingOlder: false, error: "" });

const scopeParams = (scope: ActivityScope) => new URLSearchParams({ project: scope.project, run: scope.runId ?? "",
  ...(scope.epoch ? { epoch: scope.epoch } : {}) });

export function useActivityFeed(options: {
  project: string; run: string; epoch?: string; enabled: boolean; refresh: boolean; selectedBlock?: string; archiveRevision?: number;
}) {
  const { project, run, epoch, enabled, refresh, selectedBlock, archiveRevision } = options;
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<FeedState>(emptyState);
  const current = useRef(state);
  const selection = useRef(selectedBlock);
  selection.current = selectedBlock;
  const criteria = useRef({ filter, query: search });
  criteria.current = { filter, query: search };
  const historyRequest = useRef<AbortController | null>(null);
  const historyLoading = useRef(false);
  const update = useCallback((change: (previous: FeedState) => FeedState) => {
    current.current = change(current.current);
    setState(current.current);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // This stream starts with only the selected run identity, independently of /api/run.
  useEffect(() => {
    update(() => emptyState());
    if (!enabled || !project || !run) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reader = new ActivityChangesClient({ project, run, epoch, limit: ACTIVITY_PAGE_SIZE });
    const load = async () => {
      let more = false;
      try {
        const result = await reader.read(controller.signal);
        if (controller.signal.aborted) return;
        more = result.hasMore;
        const previous = current.current;
        const reset = result.mode === "snapshot" || !sameScope(previous.scope, result.scope)
          || previous.generation !== result.projection.generation;
        const merged = mergeActivity(reset ? [] : previous.blocks, result.blocks, {
          ...criteria.current, append: reset || !previous.historical,
          keep: previous.historical && !reset ? "oldest" : "latest", limit: ACTIVITY_WINDOW_SIZE,
        });
        update(value => ({ ...(reset ? emptyState() : value), scope: reset ? result.scope : value.scope,
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
        if (!controller.signal.aborted) update(value => ({ ...value, loading: false, error: String(error) }));
      } finally {
        if (!controller.signal.aborted && (refresh || more)) timer = setTimeout(load, more ? 0 : 2500);
      }
    };
    void load();
    return () => { controller.abort(); historyRequest.current?.abort(); clearTimeout(timer); };
  }, [project, run, epoch, enabled, refresh, archiveRevision, update]);

  const scope = state.scope;
  const generation = state.generation;

  // The server owns search and pagination. Only a bounded window stays in the browser.
  useEffect(() => {
    if (!enabled || !scope || !acceptsScope(scope, project, run, epoch)) return;
    const controller = new AbortController();
    historyRequest.current?.abort();
    historyRequest.current = controller;
    historyLoading.current = true;
    update(value => ({ ...value, loading: true, loadingOlder: false, error: "" }));
    const params = scopeParams(scope);
    params.set("mode", "history"); params.set("kind", filter); params.set("q", search);
    params.set("limit", String(ACTIVITY_PAGE_SIZE));
    void requestActivity(params, controller.signal).then(result => {
      if (controller.signal.aborted || !sameScope(result.scope, current.current.scope)
        || result.projection.generation !== current.current.generation) return;
      update(value => ({ ...value, blocks: mergeActivity(result.blocks,
        value.blocks.filter(block => block.revision > result.projection.revision || block.status === "running"), {
          filter, query: search, append: true, keep: "latest", limit: ACTIVITY_WINDOW_SIZE,
        }), before: result.before ?? null, hasMore: result.hasMore, total: result.total ?? 0,
        historical: false, loading: false, error: "" }));
    }).catch(error => {
      if (!controller.signal.aborted) update(value => ({ ...value, loading: false, error: String(error) }));
    }).finally(() => {
      if (historyRequest.current === controller) historyLoading.current = false;
    });
    return () => controller.abort();
  }, [enabled, project, run, epoch, scope, generation, state.snapshot, filter, search, reload, update]);

  useEffect(() => {
    update(value => ({ ...value, selected: undefined, selectionReady: false }));
    if (!enabled || !scope || !selectedBlock || !acceptsScope(scope, project, run, epoch)) return;
    const controller = new AbortController();
    const params = scopeParams(scope);
    params.set("mode", "block"); params.set("id", selectedBlock);
    void requestActivity(params, controller.signal).then(result => {
      if (controller.signal.aborted || !sameScope(result.scope, current.current.scope)
        || result.projection.generation !== current.current.generation) return;
      update(value => ({ ...value, selected: result.blocks[0]
        ? newerBlock(value.blocks.find(block => block.id === selectedBlock) ??
          (value.selected?.id === selectedBlock ? value.selected : undefined), result.blocks[0]) : undefined,
        selectionReady: true }));
    }).catch(error => {
      if (!controller.signal.aborted) update(value => ({ ...value, error: String(error) }));
    });
    return () => controller.abort();
  }, [enabled, project, run, epoch, scope, generation, selectedBlock, update]);

  const earlier = useCallback(async () => {
    const previous = current.current;
    if (!previous.scope || !previous.before || historyLoading.current) return;
    const controller = new AbortController();
    historyRequest.current?.abort(); historyRequest.current = controller; historyLoading.current = true;
    update(value => ({ ...value, loadingOlder: true, error: "" }));
    const params = scopeParams(previous.scope);
    params.set("mode", "history"); params.set("kind", filter); params.set("q", search);
    params.set("before", previous.before); params.set("limit", String(ACTIVITY_PAGE_SIZE));
    try {
      const result = await requestActivity(params, controller.signal);
      if (controller.signal.aborted || !sameScope(result.scope, current.current.scope)
        || result.projection.generation !== current.current.generation) return;
      update(value => ({ ...value, blocks: mergeActivity(value.blocks, result.blocks, {
        filter, query: search, append: true, keep: "oldest", limit: ACTIVITY_WINDOW_SIZE,
      }), before: result.before ?? null, hasMore: result.hasMore, total: result.total ?? value.total,
        historical: true, loadingOlder: false }));
    } catch (error) {
      if (!controller.signal.aborted) update(value => ({ ...value, loadingOlder: false, error: String(error) }));
    } finally {
      if (historyRequest.current === controller) historyLoading.current = false;
    }
  }, [filter, search, update]);

  const valid = scope && acceptsScope(scope, project, run, epoch);
  return { ...state, blocks: valid ? state.blocks : [], selected: valid ? state.selected : undefined,
    filter, query, setFilter, setQuery, earlier, latest: () => setReload(value => value + 1) };
}

export type ActivityFeedData = ReturnType<typeof useActivityFeed>;
