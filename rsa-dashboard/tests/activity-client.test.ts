import test from "node:test";
import assert from "node:assert/strict";
import { ActivityChangesClient, requestActivity, type ActivityResponse } from "../lib/activity-client";

function page(revision: number, runId = "run-a", generation = "one"): ActivityResponse {
  return { scope: { project: "project", runId, epoch: "epoch" }, mode: "delta", blocks: [],
    cursor: `${generation}:${revision}`, hasMore: false,
    projection: { source: { component: "dashboard" }, throughSeq: revision, revision, generation,
      latestEventAt: null, latestSourceAt: null, generatedAt: "now", durationMs: 0, blockCount: 0 },
    current: { workspace: "/workspace", runId, epoch: "epoch", activity: "running", phase: "Ready",
      intent: null, observationId: null, updatedAt: null, error: null } };
}

test("activity cursor follows accepted pages, and a reset snapshot replaces the generation", async t => {
  const urls: URL[] = [];
  let response = { ...page(10), mode: "snapshot" as const };
  t.mock.method(globalThis, "fetch", async (url: string) => { urls.push(new URL(url)); return Response.json(response); });
  const client = new ActivityChangesClient({ project: "project", baseUrl: "http://localhost:3015" });
  const abort = new AbortController();
  const first = await client.read(abort.signal);
  await client.read(abort.signal);
  assert.equal(urls[1].searchParams.has("cursor"), false);
  first.acknowledge();
  response = { ...page(1, "run-b", "two"), mode: "snapshot" };
  const reset = await client.read(abort.signal);
  assert.equal(urls[2].searchParams.get("cursor"), "one:10");
  assert.equal(reset.scope.runId, "run-b");
  reset.acknowledge();
  await client.read(abort.signal);
  assert.equal(urls[3].searchParams.get("cursor"), "two:1");
});

test("fixed selection rejects other scopes; aborting after read prevents cursor acceptance", async t => {
  const urls: URL[] = [];
  let response = page(10, "other");
  t.mock.method(globalThis, "fetch", async (url: string) => { urls.push(new URL(url)); return Response.json(response); });
  const client = new ActivityChangesClient({ project: "project", run: "run-a", epoch: "epoch", baseUrl: "http://localhost:3015" });
  const first = new AbortController();
  await assert.rejects(client.read(first.signal), /其他运行范围/);
  response = page(10);
  const pending = await client.read(first.signal);
  first.abort(); pending.acknowledge();
  await client.read(new AbortController().signal);
  assert.equal(urls.at(-1)!.searchParams.has("cursor"), false);
  assert.equal(urls.at(-1)!.searchParams.get("run"), "run-a");
});

test("the same request helper supports bounded history and reports server errors", async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url); return Response.json({ error: "Unknown run" }, { status: 404 });
  });
  await assert.rejects(requestActivity(new URLSearchParams({ project: "project", mode: "history", before: "opaque" }),
    new AbortController().signal), /Unknown run/);
  assert.equal(urls[0], "/api/activity?project=project&mode=history&before=opaque");
});
