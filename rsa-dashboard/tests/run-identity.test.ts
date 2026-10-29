import { test } from "node:test";
import assert from "node:assert/strict";
import { runIdentity } from "../lib/run-identity";

test("run summaries retain the full year, seconds and recorded millisecond precision", () => {
  for (const [id, summary] of [
    ["2026-10-30T09-12-00.123Z", "2026/10/30 17:12:00.123"],
    ["2026-10-30T09-12-00.000Z", "2026/10/30 17:12:00.000"],
    ["2026-10-30T09-12-59.999Z", "2026/10/30 17:12:59.999"],
    ["2025-10-30T09-12-00.123Z", "2025/10/30 17:12:00.123"],
    ["2026-10-30T09-12-00Z", "2026/10/30 17:12:00"],
  ]) assert.deepEqual(runIdentity(id), { id, summary });
});

test("Shanghai summaries carry UTC timestamps across local day and year boundaries", () => {
  for (const [id, summary] of [
    ["2025-12-31T16-00-00.001Z", "2026/01/01 00:00:00.001"],
    ["2026-01-31T16-00-00Z", "2026/02/01 00:00:00"],
    ["2026-10-30T15-59-59.999Z", "2026/10/30 23:59:59.999"],
  ]) assert.deepEqual(runIdentity(id), { id, summary });
});

test("valid leap days format while invalid calendar dates and clock fields remain raw IDs", () => {
  for (const [id, summary] of [
    ["2024-02-29T12-00-00.000Z", "2024/02/29 20:00:00.000"],
    ["2000-02-29T12-00-00Z", "2000/02/29 20:00:00"],
  ]) assert.deepEqual(runIdentity(id), { id, summary });
  for (const id of [
    "2025-02-29T09-12-00.000Z", "1900-02-29T09-12-00Z", "2026-02-30T09-12-00.000Z",
    "2026-04-31T09-12-00Z", "2026-13-30T09-12-00Z", "2026-00-30T09-12-00Z",
    "2026-10-00T09-12-00Z", "2026-10-32T09-12-00Z", "2026-10-30T24-00-00Z",
    "2026-10-30T25-12-00Z", "2026-10-30T09-60-00Z", "2026-10-30T09-12-60Z",
  ]) assert.deepEqual(runIdentity(id), { id, summary: null }, id);
});

test("suffixes preserve distinct full identities even when date summaries are equal", () => {
  const ids = [
    "2026-10-30T09-12-00.123Z", "2026-10-30T09-12-00.123Z-01ab23ef",
    "2026-10-30T09-12-00.123Z-custom-a", "2026-10-30T09-12-00.123Z-custom-b",
    "2026-10-30T09-12-00.123Z-release_2.1-long-suffix",
  ];
  const results = ids.map(runIdentity);
  assert.deepEqual(results.map(result => result.id), ids);
  assert.ok(results.every(result => result.summary === "2026/10/30 17:12:00.123"));
  const withoutMillis = "2026-10-30T09-12-00Z-custom-a";
  assert.deepEqual(runIdentity(withoutMillis), { id: withoutMillis, summary: "2026/10/30 17:12:00" });
});

test("noncanonical timestamps and custom IDs are never partially parsed or normalized", () => {
  for (const id of [
    "manual-a", "2026/10/30 17:12:00.123", "2026-10-30T09-12-00", "2026-10-30T09:12:00.123Z",
    "2026-10-30T09-12-00.1Z", "2026-10-30T09-12-00.12Z", "2026-10-30T09-12-00.1234Z",
    "2026-10-30T09-12-00.123z", "2026-10-30T09-12-00.123Z-", "2026-10-30T09-12-00.123Zsuffix",
    "2026-10-30T09-12-00.123Z-with/slash", "2026-10-30T09-12-00.123Z-with space",
    "2026-10-30T09-12-00.123Z\n", " 2026-10-30T09-12-00.123Z", "",
  ]) assert.deepEqual(runIdentity(id), { id, summary: null }, JSON.stringify(id));
});

test("dates needing an era are not presented as a misleading AD timestamp", () => {
  const id = "0000-01-01T00-00-00Z";
  assert.deepEqual(runIdentity(id), { id, summary: null });
});
