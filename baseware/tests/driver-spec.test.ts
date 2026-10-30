import { expect, test } from "bun:test";
import { asRegistration, driverCacheDir, parseDriverSpec } from "../src/drivers/spec.ts";

test("parseDriverSpec accepts npm specs", () => {
  expect(parseDriverSpec("@ludens/driver-foo@1.0.0")).toEqual({ kind: "npm", package: "@ludens/driver-foo@1.0.0" });
  expect(parseDriverSpec("some-driver")).toEqual({ kind: "npm", package: "some-driver" });
  expect(parseDriverSpec("npm:@ludens/driver-foo@1.0.0")).toEqual({ kind: "npm", package: "@ludens/driver-foo@1.0.0" });
});

test("parseDriverSpec requires pinned github revisions", () => {
  expect(parseDriverSpec("github:org/driver-foo#abc123")).toEqual(
    { kind: "github", org: "org", repo: "driver-foo", rev: "abc123", url: "https://github.com/org/driver-foo.git" });
  expect(parseDriverSpec("org/driver-foo#v1")).toMatchObject({ kind: "github", org: "org", rev: "v1" });
  expect(parseDriverSpec("https://github.com/org/driver-foo.git#abc123")).toMatchObject({ kind: "github", rev: "abc123" });
  expect(parseDriverSpec("org/driver-foo.git#v1")).toMatchObject({ repo: "driver-foo", url: "https://github.com/org/driver-foo.git" });
  expect(parseDriverSpec("github:org/driver-foo.git#v1")).toMatchObject({ repo: "driver-foo" });
  expect(() => parseDriverSpec("github:org/driver-foo")).toThrow("must pin a revision");
  expect(() => parseDriverSpec("org/driver-foo")).toThrow("must pin a revision");
  expect(() => parseDriverSpec("https://github.com/org/driver-foo")).toThrow("must pin a revision");
});

test("GitHub SSH input preserves its authentication transport", () => {
  expect(parseDriverSpec("git@github.com:org/private-driver.git#v1")).toEqual({
    kind: "github", org: "org", repo: "private-driver", rev: "v1", url: "git@github.com:org/private-driver.git",
  });
  expect(parseDriverSpec("git@github.com:org/private-driver#abc123")).toMatchObject({ url: "git@github.com:org/private-driver.git" });
  expect(() => parseDriverSpec("https://user:secret@github.com/org/private-driver#v1")).toThrow();
});

test("parseDriverSpec accepts file paths for development", () => {
  expect(parseDriverSpec("file:../my-driver")).toEqual({ kind: "file", path: "../my-driver" });
  expect(() => parseDriverSpec("file:")).toThrow("Empty file:");
});

test("driverCacheDir rejects traversal", () => {
  expect(driverCacheDir("/tmp/cache/", "custom-emu")).toBe("/tmp/cache/custom-emu");
  expect(() => driverCacheDir("/tmp/cache", "../evil")).toThrow("Invalid driver id");
});

test("asRegistration narrows module exports", () => {
  const registration = { id: "foo", load: async () => { throw new Error("unused"); } };
  expect(asRegistration({ default: registration }, "foo")).toBe(registration);
  expect(asRegistration({ registration }, "foo")).toBe(registration);
  expect(asRegistration(registration, "foo")).toBe(registration);
  expect(() => asRegistration(registration, "bar")).toThrow("does not match");
  expect(() => asRegistration({ default: { id: "foo" } }, "foo")).toThrow("no load()");
  expect(() => asRegistration({}, "foo")).toThrow("string id");
  expect(asRegistration({ ...registration, launchEnv: { DOTNET_DefaultStackSize: "200000" } }).launchEnv).toEqual({ DOTNET_DefaultStackSize: "200000" });
  expect(() => asRegistration({ ...registration, launchEnv: { INVALID: 1 } })).toThrow("invalid launchEnv");
});

test("registration identifiers, versions and ports follow the manifest contract", () => {
  const registration = { id: "fixture", load() {} };
  for (const id of ["../escape", "bad name", "-leading", "bad;command"]) {
    expect(() => asRegistration({ ...registration, id })).toThrow("Invalid driver id");
  }
  for (const field of ["version", "fallbackVersion"] as const) {
    for (const value of [1, {}, null]) {
      expect(() => asRegistration({ ...registration, [field]: value })).toThrow(`invalid ${field}`);
    }
    expect(asRegistration({ ...registration, [field]: "v1" })[field]).toBe("v1");
  }
  for (const defaultPort of [-1, 0, 65536, 1.5, NaN, Infinity, "1234"]) {
    expect(() => asRegistration({ ...registration, defaultPort })).toThrow("invalid defaultPort");
  }
  for (const defaultPort of [1, 65535]) {
    expect(asRegistration({ ...registration, defaultPort }).defaultPort).toBe(defaultPort);
  }
});
