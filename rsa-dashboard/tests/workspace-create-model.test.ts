import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyWorkspaceDraft, normalizedWorkspacePath, switchWorkspaceEnvironment, workspaceCreateInput,
  workspaceDriverCapabilities, workspaceLocation,
} from "../components/workspace-create-model";
import type { DiscoveredDriver } from "../lib/drivers";

const root = "/Users/example/workspaces";
const desktop = { ...emptyWorkspaceDraft, name: "My workspace" };
const driver: DiscoveredDriver = {
  id: "example", spec: "github:example/driver#v1", version: "1.0", transport: "bridge", defaultPort: 47663,
  needsGame: true, launchCommand: ["example-emulator"],
};

test("desktop creation only needs a folder name and leaves the default root to the server", () => {
  assert.deepEqual(workspaceCreateInput(root, desktop, null), { ok: true, input: { name: "My workspace", driver: "cua" } });
  assert.equal(workspaceLocation(root, desktop).path, `${root}/My workspace`);
  assert.equal(workspaceCreateInput(root, { ...desktop, name: "../other" }, null).ok, false);
});

test("a custom final directory determines the displayed and submitted folder name without losing the draft", () => {
  const draft = { ...desktop, targetDirectory: " /Volumes/work/old/../Different name/ " };
  assert.deepEqual(workspaceLocation(root, draft), { path: "/Volumes/work/Different name", name: "Different name", custom: true });
  assert.deepEqual(workspaceCreateInput(root, draft, null), {
    ok: true, input: { name: "Different name", driver: "cua", workspace: "/Volumes/work/Different name" },
  });
  assert.equal(workspaceLocation(root, { ...draft, targetDirectory: "" }).name, "My workspace");
  for (const targetDirectory of ["relative/path", "/", "/work/../", "/bad\0path"])
    assert.equal(workspaceCreateInput(root, { ...desktop, targetDirectory }, null).ok, false);
  assert.equal(normalizedWorkspacePath("/a/./b/../c"), "/a/c");
});

test("a changed community package cannot reuse an old verification", () => {
  const draft = { ...desktop, environment: "community" as const, driverPackage: driver.spec };
  assert.equal(workspaceCreateInput(root, draft, null).ok, false);
  assert.equal(workspaceCreateInput(root, { ...draft, driverPackage: `${driver.spec}2` }, driver).ok, false);
  assert.deepEqual(workspaceCreateInput(root, draft, driver), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec },
  });
});

test("driver capabilities determine submitted fields; needsGame never makes a game path mandatory", () => {
  const draft = { ...desktop, environment: "community" as const, driverPackage: driver.spec, game: " games/demo.bin ", cuaCommand: "/old/cua" };
  assert.deepEqual(workspaceCreateInput(root, draft, driver), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec, game: "games/demo.bin" },
  });
  const manual = { ...driver, launchCommand: undefined };
  assert.equal(workspaceDriverCapabilities("community", manual).supportsGame, false);
  assert.deepEqual(workspaceCreateInput(root, draft, manual), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec },
  });
  const stdio = { ...driver, transport: "stdio", defaultPort: undefined };
  assert.deepEqual(workspaceCreateInput(root, draft, stdio), {
    ok: true, input: { name: draft.name, driver: driver.id, driverPackage: driver.spec, cuaCommand: "/old/cua" },
  });
  assert.equal(workspaceCreateInput(root, { ...draft, game: "" }, driver).ok, true);
  assert.equal(workspaceCreateInput(root, draft, { ...driver, defaultPort: undefined }).ok, false);
});

test("switching environments clears device options and never submits a hidden community package", () => {
  const community = { ...desktop, environment: "community" as const, driverPackage: driver.spec, game: "/game", cuaCommand: "/driver" };
  const switched = switchWorkspaceEnvironment(community, "desktop");
  assert.equal(switched.game, ""); assert.equal(switched.cuaCommand, "");
  assert.deepEqual(workspaceCreateInput(root, switched, driver), { ok: true, input: { name: desktop.name, driver: "cua" } });
  assert.deepEqual(workspaceCreateInput(root, { ...community, environment: "desktop" }, driver), {
    ok: true, input: { name: desktop.name, driver: "cua", cuaCommand: "/driver" },
  });
});
