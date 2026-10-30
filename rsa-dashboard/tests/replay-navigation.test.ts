import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReplayElapsed, replayElapsedInput, replayEvidenceFromSearch, replayEvidencePatch } from "../components/replay-navigation";

test("four-hour navigation accepts precise elapsed time without confusing wall-clock timestamps", () => {
  assert.equal(parseReplayElapsed("02:37:15"), 9_435_000);
  assert.equal(parseReplayElapsed("157:15.125"), 9_435_125);
  assert.equal(parseReplayElapsed("9435.125"), 9_435_125);
  assert.equal(parseReplayElapsed(" 0:01 "), 1000);
  assert.equal(parseReplayElapsed("4:00:00"), 14_400_000);
  assert.equal(parseReplayElapsed("5:00:00"), 18_000_000); // The UI explicitly clamps to recording length.
  assert.equal(replayElapsedInput(9_435_125, "seconds"), "02:37:15");
  assert.equal(replayElapsedInput(14_400_000, "seconds"), "04:00:00");
  for (const value of ["", "-10", "+10", "1:60", "01:60:00", "1:02:60", "1:2:3:4", "NaN", "Infinity", "1e5", "1.0001", "90071992547409910"]) assert.equal(parseReplayElapsed(value), null, value);
});

test("editable elapsed values round-trip milliseconds across duration boundaries", () => {
  const cases: Array<[number, string]> = [
    [0, "00:00:00"], [1, "00:00:00.001"], [9, "00:00:00.009"],
    [10, "00:00:00.010"], [99, "00:00:00.099"], [100, "00:00:00.100"],
    [125, "00:00:00.125"], [999, "00:00:00.999"], [1000, "00:00:01"],
    [59_999, "00:00:59.999"], [60_000, "00:01:00"],
    [3_599_999, "00:59:59.999"], [3_600_000, "01:00:00"],
    [9_435_125, "02:37:15.125"], [14_400_000, "04:00:00"],
    [14_400_125, "04:00:00.125"], [360_000_001, "100:00:00.001"],
  ];
  for (const [milliseconds, expected] of cases) {
    const displayed = replayElapsedInput(milliseconds, "milliseconds");
    assert.equal(displayed, expected);
    assert.equal(parseReplayElapsed(displayed), milliseconds, "Unchanged submission preserves the exact target, including a fractional recording end");
    assert.equal(replayElapsedInput(parseReplayElapsed(displayed)!, "milliseconds"), displayed);
  }
});

test("editable values distinguish same-second seeks while passive labels retain second precision", () => {
  assert.equal(replayElapsedInput(9_435_125, "milliseconds"), "02:37:15.125");
  assert.equal(replayElapsedInput(9_435_875, "milliseconds"), "02:37:15.875");
  for (const milliseconds of [9_435_000, 9_435_125, 9_435_875, 9_435_999.9]) {
    assert.equal(replayElapsedInput(milliseconds, "seconds"), "02:37:15");
  }
});

test("elapsed formatting floors sub-millisecond values without crossing a boundary", () => {
  for (const milliseconds of [-1, -0.1, 0, 0.9, 999.9, 1000.9, 59_999.9, 3_599_999.9]) {
    assert.equal(parseReplayElapsed(replayElapsedInput(milliseconds, "milliseconds")), Math.floor(Math.max(0, milliseconds)));
  }
  assert.equal(replayElapsedInput(999.9, "milliseconds"), "00:00:00.999");
  assert.equal(replayElapsedInput(1000.9, "milliseconds"), "00:00:01");
});

test("replay links round-trip exact item and frame references without sharing live-view selection keys", () => {
  for (const selection of [{kind:"item",id:"event:123"},{kind:"frame",record:"screen/a +中文",sequence:42}] as const) {
    const params = new URLSearchParams({call:"live-call",image:"live-image"});
    for (const [key,value] of Object.entries(replayEvidencePatch(selection))) if (value !== null) params.set(key,value);
    assert.deepEqual(replayEvidenceFromSearch(params.toString()), selection);
    for (const [key,value] of Object.entries(replayEvidencePatch(null))) { assert.equal(value,null);params.delete(key); }
    assert.equal(replayEvidenceFromSearch(params.toString()),null);
    assert.equal(params.get("call"),"live-call");
  }
});

test("malformed or conflicting evidence references never silently select a different record", () => {
  assert.deepEqual(replayEvidenceFromSearch('?replayRecord=frame&replaySequence=-2'),{kind:"frame",record:"frame",sequence:0});
  assert.deepEqual(replayEvidenceFromSearch('?replayRecord=frame&replaySequence=1.2'),{kind:"frame",record:"frame",sequence:0});
  assert.deepEqual(replayEvidenceFromSearch('?replaySequence=2'),{kind:"frame",record:"",sequence:2});
  assert.deepEqual(replayEvidenceFromSearch('?replayItem=event:1&replayRecord=x'),{kind:"item",id:""});
});
