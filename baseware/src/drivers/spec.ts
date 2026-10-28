import type { DriverRegistration } from "./registry.ts";

/** Where a community driver package comes from. Everything here is pure and side-effect free. */
export type DriverSpec =
  | { kind: "npm"; package: string }
  | { kind: "github"; org: string; repo: string; rev: string; url: string }
  | { kind: "file"; path: string };

const NAME = "[A-Za-z0-9_.-]+";

function githubRepo(rest: string): { org: string; repo: string; rev: string } {
  const match = rest.match(new RegExp(`^(${NAME})/(${NAME})(?:\\.git)?(?:#(.+))?$`));
  if (!match) throw new Error(`Invalid github driver spec: expected org/repo#<commit/tag>, got ${JSON.stringify(rest)}`);
  const [, org, repo, rev] = match;
  if (!rev) throw new Error(`Github driver spec must pin a revision: ${JSON.stringify(rest)} — append #<commit/tag>`);
  return { org, repo: repo.replace(/\.git$/, ""), rev };
}

/** Parse a --driver-package value. Accepts npm specs, github repo links and file: paths. */
export function parseDriverSpec(text: string): DriverSpec {
  const spec = text.trim();
  if (!spec) throw new Error("Empty --driver-package spec");
  if (spec.startsWith("file:")) {
    const path = spec.slice("file:".length).trim();
    if (!path) throw new Error("Empty file: path in --driver-package spec");
    return { kind: "file", path };
  }
  const ghUrl = spec.match(/^https?:\/\/github\.com\/([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/);
  if (ghUrl) {
    const [, org, repo, rev] = ghUrl;
    if (!rev) throw new Error(`Github driver spec must pin a revision: ${JSON.stringify(spec)} — append #<commit/tag>`);
    return { kind: "github", org, repo, rev, url: `https://github.com/${org}/${repo}.git` };
  }
  const ssh = spec.match(/^git@github\.com:([^/#]+)\/([^#]+?)(?:\.git)?#(.+)$/);
  if (ssh) {
    const [, org, repo, rev] = ssh;
    return { kind: "github", org, repo, rev, url: `https://github.com/${org}/${repo}.git` };
  }
  if (spec.startsWith("github:")) {
    const { org, repo, rev } = githubRepo(spec.slice("github:".length));
    return { kind: "github", org, repo, rev, url: `https://github.com/${org}/${repo}.git` };
  }
  if (spec.startsWith("npm:")) {
    const package_ = spec.slice("npm:".length).trim();
    if (!new RegExp(`^(@${NAME}\\/${NAME}|${NAME})(@[^\\s/@]+)?$`).test(package_)) {
      throw new Error(`Invalid npm driver spec: ${JSON.stringify(spec)}`);
    }
    return { kind: "npm", package: package_ };
  }
  if (spec.startsWith("@") || !spec.includes("/")) {
    if (!new RegExp(`^(@${NAME}\\/${NAME}|${NAME})(@[^\\s/@]+)?$`).test(spec)) {
      throw new Error(`Invalid npm driver spec: ${JSON.stringify(spec)}`);
    }
    return { kind: "npm", package: spec };
  }
  const { org, repo, rev } = githubRepo(spec);
  return { kind: "github", org, repo, rev, url: `https://github.com/${org}/${repo}.git` };
}

/** Driver ids double as cache directory names; reject traversal. */
export function driverCacheDir(cacheRoot: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`Invalid driver id: ${JSON.stringify(id)}`);
  return `${cacheRoot.replace(/\/+$/, "")}/${id}`;
}

/** Narrow an imported module's export to a DriverRegistration. Pure; throws on shape mismatch. */
export function asRegistration(value: unknown, expectedId?: string): DriverRegistration {
  const root = value as { default?: unknown; registration?: unknown; driver?: unknown } | null;
  const exported = root !== null && typeof root === "object" && !Array.isArray(root)
    ? (root.default ?? root.registration ?? root.driver ?? root)
    : undefined;
  const candidate = exported as { id?: unknown; load?: unknown; transport?: unknown; defaultPort?: unknown; needsGame?: unknown; launchHint?: unknown; launchCommand?: unknown; launchEnv?: unknown } | undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || typeof candidate.id !== "string" || !candidate.id) {
    throw new Error("Driver package must export a registration object with a string id (default, registration or driver export)");
  }
  if (expectedId && candidate.id !== expectedId) {
    throw new Error(`Driver package id ${JSON.stringify(candidate.id)} does not match --driver ${JSON.stringify(expectedId)}`);
  }
  if (typeof candidate.load !== "function") throw new Error(`Driver package ${JSON.stringify(candidate.id)} registration has no load() function`);
  if (candidate.defaultPort !== undefined
    && (typeof candidate.defaultPort !== "number" || !Number.isInteger(candidate.defaultPort))) {
    throw new Error(`Driver package ${JSON.stringify(candidate.id)} has an invalid defaultPort`);
  }
  if (candidate.transport !== undefined && candidate.transport !== "bridge" && candidate.transport !== "stdio") {
    throw new Error(`Driver package ${JSON.stringify(candidate.id)} has an invalid transport`);
  }
  if (candidate.needsGame !== undefined && typeof candidate.needsGame !== "boolean") {
    throw new Error(`Driver package ${JSON.stringify(candidate.id)} has an invalid needsGame`);
  }
  if (candidate.launchHint !== undefined && typeof candidate.launchHint !== "string") {
    throw new Error(`Driver package ${JSON.stringify(candidate.id)} has an invalid launchHint`);
  }
  if (candidate.launchCommand !== undefined
    && (!Array.isArray(candidate.launchCommand) || !candidate.launchCommand.every(item => typeof item === "string"))) {
    throw new Error(`Driver package ${JSON.stringify(candidate.id)} has an invalid launchCommand`);
  }
  if (candidate.launchEnv !== undefined
    && (candidate.launchEnv === null || typeof candidate.launchEnv !== "object" || Array.isArray(candidate.launchEnv)
      || !Object.values(candidate.launchEnv).every(value => typeof value === "string"))) {
    throw new Error(`Driver package ${JSON.stringify(candidate.id)} has an invalid launchEnv`);
  }
  return candidate as unknown as DriverRegistration;
}
