import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { driverInitCommand } from "../lib/driver-command";
import { CapabilitiesView } from "../components/capabilities-view";

test("copied initialization commands retain verified argv literally in a POSIX shell", () => {
  const verified = {
    id: "fixture's driver",
    spec: "file:/tmp/a driver's folder/$(printf substituted)/`printf changed`;echo nope.ts",
  };
  const result = spawnSync("/bin/sh", ["-c", `rsa() { printf '%s\\0' "$@"; }; ${driverInitCommand(verified)}`]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.toString(), "");
  assert.deepEqual(result.stdout.toString().split("\0"), ["init", "--driver", verified.id, "--driver-package", verified.spec, ""]);
});

test("external driver discovery remains visible without a usable workspace catalog", () => {
  for (const props of [
    { project: "", ready: false },
    { project: "", ready: true },
    { project: "missing", ready: true, catalogError: "catalog unavailable" },
  ]) {
    const html = renderToStaticMarkup(createElement(CapabilitiesView, props));
    assert.match(html, /aria-label="capabilitiesView\.driverSectionLabel"/);
    assert.match(html, /aria-label="capabilitiesView\.specAriaLabel"/);
    assert.match(html, /<form/);
    assert.match(html, /capabilitiesView\.discoverNote2a/);
    assert.match(html, /capabilitiesView\.discoverNote2b/);
  }
});
