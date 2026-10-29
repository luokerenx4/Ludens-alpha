import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { driverCreationHref } from "../lib/driver-onboarding";
import { isPlainNavigationClick } from "../lib/dashboard-navigation";
import { CapabilitiesView } from "../components/capabilities-view";

test("driver handoff URLs preserve the package literally but never transmit trusted metadata", () => {
  for (const spec of ["github:org/repo#rev", "file:/tmp/a driver's folder/$(echo x)&verified=true&driver=cua.ts"]) {
    const url = new URL(driverCreationHref(spec), "http://localhost");
    assert.equal(url.pathname, "/");
    assert.equal(url.searchParams.get("view"), "workspaces");
    assert.equal(url.searchParams.get("create"), "1");
    assert.equal(url.searchParams.get("driverPackage"), spec);
    assert.deepEqual([...url.searchParams.keys()], ["view", "create", "driverPackage"]);
  }
});

test("only unmodified primary activation is intercepted for an in-memory handoff", () => {
  const event = { button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(isPlainNavigationClick(event), true);
  for (const patch of [{ button: 1 }, { button: 2 }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }])
    assert.equal(isPlainNavigationClick({ ...event, ...patch }), false);
});

test("package verification and navigation remain available without a usable workspace catalog", () => {
  for (const props of [{ project: "", ready: false }, { project: "", ready: true },
    { project: "missing", ready: true, catalogError: "catalog unavailable" }]) {
    const html = renderToStaticMarkup(createElement(CapabilitiesView, { ...props, workspace: null,
      onRetryCatalog() {}, onCreateWithDriver() {}, onNavigate() {} }));
    assert.match(html, /aria-label="capabilitiesView\.driverSectionLabel"/);
    assert.match(html, /<label[^>]*for="driver-package-spec"[^>]*>capabilitiesView\.specAriaLabel<\/label>/);
    assert.match(html, /<input[^>]*id="driver-package-spec"/);
    assert.match(html, /<form/);
    assert.match(html, /capabilitiesView\.discoverNote2a/);
    assert.match(html, /capabilitiesView\.discoverNote2b/);
    assert.match(html, /view=docs/);
    assert.doesNotMatch(html, /rsa init/);
  }
});
