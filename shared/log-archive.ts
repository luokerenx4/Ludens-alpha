/** Workspace log objects. Node-only so the host, Dashboard and offline tools share one codec. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { TimelineAssetReference, VideoFrameReference } from "./timeline-types";
import { validateVideoReference } from "./timeline-media";

export interface JsonArchiveRef {
  encoding: "rsa-json-v1";
  path: string;
  sha256: string;
  /** Size of the original JSON value, not the encoded object or wire body. */
  bytes: number;
}
/** Small stream records stay inline to avoid one filesystem allocation per token delta. */
export interface InlineJsonArchiveRef extends Omit<JsonArchiveRef, "path"> { inline: Node }
export interface MediaReference {
  sha256: string;
  bytes: number;
  mediaType?: string;
  asset?: string;
  /** Video references are registered before encoding finishes; the sidecar owns readiness. */
  status: "recorded" | "referenced" | "unrecorded";
  reason?: string;
  video?: VideoFrameReference;
  /** A video frame reconstructs perception, not the exact delivered image bytes. */
  approximate?: boolean;
}
export interface ReadOptions { media?: "reference" | "full"; workspace?: string | null }
type Scalar = string | number | boolean | null;
type Escapes = [number, number, `u${number}` | '"' | "\\" | "/" | "b" | "f" | "n" | "r" | "t"][];
type Node = ["v", Scalar] | ["a", Node[]] | ["o", [string, Node][]] | ["r", string]
  | ["m", MediaReference] | ["s", Node[]] | ["e", Node, Escapes];
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const objectPath = (sha: string) => {
  if (!HASH.test(sha)) throw new Error("Invalid archive object hash");
  return `objects/${sha}.json.gz`;
};
const mediaPath = (asset: string) => {
  if (!/^(?:objects|window-[a-zA-Z0-9_-]+)\/[a-f0-9]{64}\.bin$/.test(asset)) throw new Error("Invalid timeline asset");
  return asset;
};
const mediaType = (value: any, key: string, container?: string) => {
  if ((key === "data" || key === "blob") && value && typeof value === "object"
    && (["image", "audio", "input_audio", "input_image"].includes(value.type)
      || container === "input_audio" || typeof value.mediaType === "string" || typeof value.mimeType === "string"
      || value.type === "base64" && typeof value.media_type === "string"))
    return value.mediaType ?? value.mimeType ?? value.media_type
      ?? (container === "input_audio" ? `audio/${value.format ?? "unknown"}`
        : value.type?.includes("audio") ? "audio/unknown" : "image/unknown");
  return undefined;
};

function canonicalBase64(value: string) {
  if (!value || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

// Keep JSON spelling without keeping the escaped media itself. Ranges contain
// positions and styles only; characters are reconstructed from the retained asset.
function jsonEscapes(raw: string): Escapes {
  const ranges: Escapes = []; let shrink = 0;
  for (const match of raw.matchAll(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g)) {
    const at = match.index! - shrink;
    const caseMask = match[1] ? [...match[1]].reduce((mask, char, i) => mask | (/[A-F]/.test(char) ? 1 << i : 0), 0) : 0;
    const style = (match[1] ? `u${caseMask}` : match[2]!) as Escapes[number][2];
    const last = ranges.at(-1);
    if (last && last[1] === at && last[2] === style) last[1]++;
    else ranges.push([at, at + 1, style]);
    shrink += match[0].length - 1;
  }
  return ranges;
}
function escapeJson(value: string, ranges: Escapes) {
  let text = "", after = 0;
  for (const [start, end, style] of ranges) {
    text += value.slice(after, start);
    for (let at = start; at < end; at++) {
      const hex = value.charCodeAt(at).toString(16).padStart(4, "0");
      text += style.startsWith("u") ? "\\u" + [...hex].map((char, i) =>
        Number(style.slice(1)) & 1 << i ? char.toUpperCase() : char).join("") : `\\${style}`;
    }
    after = end;
  }
  return text + value.slice(after);
}

/** Canonical directories only; do not follow a workspace's .rsa/archive symlink when writing. */
function ensureDirectory(root: string, parts: string[]) {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (realpathSync(path) !== path || !statSync(path).isDirectory()) throw new Error("Archive directory must be canonical");
  }
  return path;
}

export class JsonArchive {
  readonly workspace: string;
  readonly root: string;
  // Only small identities, never bytes or parsed histories. Eviction affects discovery, not stored references.
  private media = new Map<string, TimelineAssetReference & { indexed?: boolean }>();
  constructor(workspace: string) {
    this.workspace = realpathSync(workspace);
    this.root = ensureDirectory(this.workspace, [".rsa", "archive"]);
    ensureDirectory(this.root, ["objects"]);
    ensureDirectory(this.root, ["media"]);
  }

  registerMedia(media: { sha256: string; asset: string; video?: VideoFrameReference; [key: string]: unknown }) {
    if (!HASH.test(media.sha256)) throw new Error("Invalid media hash");
    if (media.video) validateVideoReference(media);
    else {
      mediaPath(media.asset);
      if (!media.asset.endsWith(`/${media.sha256}.bin`)) throw new Error("Timeline media hash mismatch");
    }
    // The byte lookup is a reconstruction source, not the observation's time.
    // A later dropped copy must not invalidate identical older model images.
    const previous = this.media.get(media.sha256);
    if (media.video?.status === "gap" && previous && previous.video?.status !== "gap") return;
    this.media.delete(media.sha256);
    this.media.set(media.sha256, { asset: media.asset, ...(media.video ? { video: { ...media.video } } : {}) });
    if (this.media.size > 4096) this.media.delete(this.media.keys().next().value!);
  }

  /** Only images consumed by logging get a durable, byte-free lookup. Sampling
   * may evict the hot map; resumed/full requests still find the same source. */
  private videoReference(sha256: string) {
    let reference = this.media.get(sha256);
    if (reference?.indexed) return reference;
    const directory = ensureDirectory(this.workspace, [".rsa", "archive", "media"]);
    const path = join(directory, `${sha256}.json`);
    let indexed = false;
    try {
      if (realpathSync(path) !== path || statSync(path).size > 64 * 1024) throw new Error("Invalid archived media index");
      const stored = JSON.parse(readFileSync(path, "utf8")) as TimelineAssetReference;
      validateVideoReference(stored);
      // Keep the first durable source unless it expired or encoding failed.
      // New window copies must not be rebound to an already expired window.
      let replace = false;
      if (reference?.video && reference.video.status !== "gap" && reference.asset !== stored.asset) {
        replace = stored.asset.startsWith("window-");
        if (!replace) {
          const statePath = join(this.workspace, ".rsa", "timeline", stored.asset + ".json");
          try {
            if (realpathSync(statePath) !== statePath || statSync(statePath).size > 64 * 1024)
              throw new Error("Invalid timeline video status file");
            replace = JSON.parse(readFileSync(statePath, "utf8")).status === "error";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            replace = true;
          }
        }
      }
      if (!replace) { reference = stored; indexed = true; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (reference?.video && reference.video.status !== "gap") {
      if (!indexed) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify({ asset: reference.asset, video: reference.video }) + "\n", { flag: "wx" });
          renameSync(temporary, path);
        } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      }
      this.media.delete(sha256);
      this.media.set(sha256, { ...reference, indexed: true });
      if (this.media.size > 4096) this.media.delete(this.media.keys().next().value!);
    }
    return reference;
  }

  private mediaNode(value: string, type?: string): Node {
    const bytes = canonicalBase64(value);
    if (!bytes) {
      // Invalid media is not silently archived as an enormous text blob.
      return ["m", { sha256: hash(value), bytes: Buffer.byteLength(value), mediaType: type,
        status: "unrecorded", reason: "invalid-base64" }];
    }
    const sha256 = hash(bytes);
    const registered = this.videoReference(sha256);
    if (registered?.video) {
      const gap = registered.video.status === "gap";
      return ["m", { sha256, bytes: bytes.length, ...(type ? { mediaType: type } : {}),
        asset: registered.asset, video: registered.video, approximate: true, status: gap ? "unrecorded" : "referenced",
        ...(gap ? { reason: registered.video.reason ?? "recording-gap" } : {}) }];
    }
    const asset = registered?.asset ?? `objects/${sha256}.bin`;
    const root = join(this.workspace, ".rsa", "timeline"), path = join(root, mediaPath(asset));
    let available = false;
    try { available = realpathSync(root) === root && realpathSync(path) === path && statSync(path).size === bytes.length; }
    catch { /* An unrecorded/expired image is metadata, never a second permanent archive. */ }
    return ["m", { sha256, bytes: bytes.length, ...(type ? { mediaType: type } : {}),
      ...(available ? { asset, status: "recorded" as const } : { status: "unrecorded" as const, reason: "not-retained" }) }];
  }

  private string(value: string, type?: string): Node {
    if (type) return this.mediaNode(value, type);
    const spans: { start: number; end: number; node: Node }[] = [];
    const uri = /data:([^;,\s"\\]+)(?:;[^,\s"\\]*)?;base64,([A-Za-z0-9+/]+={0,2})/g;
    let parsedJson = false;
    // Native CLI results are often JSON inside a text block. Preserve the exact
    // surrounding string; replace only identified media value spans, not its formatting.
    if (value.trimStart().startsWith("{") || value.trimStart().startsWith("[")) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); parsedJson = true; } catch { /* ordinary prose */ }
      if (parsedJson) {
        const candidates = new Map<string, Node>();
        const visit = (item: any, depth = 0, container?: string) => {
          if (typeof item === "string") {
            const matches = [...item.matchAll(uri)];
            if (matches.length) candidates.set(item, this.string(item));
            return;
          }
          if (!item || typeof item !== "object" || depth > 128) return;
          for (const [key, child] of Object.entries(item)) {
            const type = mediaType(item, key, container);
            if (type && typeof child === "string") candidates.set(child, this.mediaNode(child, type));
            else visit(child, depth + 1, key);
          }
        };
        visit(parsed);
        for (const token of value.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
          const node = candidates.get(JSON.parse(token[0]));
          if (!node) continue;
          const escapes = jsonEscapes(token[0].slice(1, -1));
          spans.push({ start: token.index! + 1, end: token.index! + token[0].length - 1,
            node: escapes.length ? ["e", node, escapes] : node });
        }
      }
    }
    if (!parsedJson) for (const match of value.matchAll(uri)) {
      const start = match.index! + match[0].length - match[2]!.length;
      spans.push({ start, end: start + match[2]!.length, node: this.mediaNode(match[2]!, match[1]) });
    }
    if (!spans.length) return ["v", value];
    const pieces: Node[] = []; let after = 0;
    for (const span of spans.sort((a, b) => a.start - b.start)) {
      if (span.start < after) continue;
      if (span.start > after) pieces.push(["v", value.slice(after, span.start)]);
      pieces.push(span.node); after = span.end;
    }
    if (after < value.length) pieces.push(["v", value.slice(after)]);
    return ["s", pieces];
  }

  private store(node: Node): string {
    const bytes = Buffer.from(JSON.stringify({ version: 1, node }));
    const sha = hash(bytes), path = join(this.root, objectPath(sha));
    ensureDirectory(this.workspace, [".rsa", "archive", "objects"]);
    if (existsSync(path)) {
      if (realpathSync(path) !== path) throw new Error("Archive object must not be a symlink");
      if (hash(gunzipSync(readFileSync(path))) !== sha) throw new Error("Archive object checksum mismatch");
      return sha;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, gzipSync(bytes), { flag: "wx" }); renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    return sha;
  }

  write(value: unknown): JsonArchiveRef;
  write(value: unknown, options: { inline?: boolean }): JsonArchiveRef | InlineJsonArchiveRef;
  write(value: unknown, options: { inline?: boolean } = {}): JsonArchiveRef | InlineJsonArchiveRef {
    // Match EventLog's JSON semantics (Date, undefined fields, toJSON) before encoding.
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Archive value is not JSON");
    const encode = (value: any, type?: string, inArray = false, depth = 0, container?: string): Node => {
      if (depth > 256) throw new Error("Archive JSON is too deeply nested");
      const node: Node = typeof value === "string" ? this.string(value, type)
        : Array.isArray(value) ? ["a", value.map(child => encode(child, undefined, true, depth + 1))]
        : value && typeof value === "object" ? ["o", Object.entries(value).map(([key, child]): [string, Node] =>
          [key, encode(child, mediaType(value, key, container), false, depth + 1, key)])]
        : ["v", value];
      const size = Buffer.byteLength(JSON.stringify(node));
      return depth > 0 && size >= (inArray ? 256 : 2048) ? ["r", this.store(node)] : node;
    };
    const node = encode(JSON.parse(json));
    const encoded = JSON.stringify({ version: 1, node });
    if (options.inline && Buffer.byteLength(encoded) <= 2048)
      return { encoding: "rsa-json-v1", inline: node, sha256: hash(encoded), bytes: Buffer.byteLength(json) };
    const sha256 = this.store(node);
    return { encoding: "rsa-json-v1", path: objectPath(sha256), sha256, bytes: Buffer.byteLength(json) };
  }
}

function verifyRef(ref: any) {
  if (ref?.encoding !== "rsa-json-v1" || !HASH.test(ref.sha256)) throw new Error("Invalid archive reference");
  if (ref.inline !== undefined) {
    if (ref.path !== undefined || hash(JSON.stringify({ version: 1, node: ref.inline })) !== ref.sha256)
      throw new Error("Inline archive checksum mismatch");
  } else if (ref.path !== objectPath(ref.sha256)) throw new Error("Invalid archive reference");
}
function parseObject(bytes: Uint8Array, sha: string): Node {
  const decoded = gunzipSync(bytes);
  if (hash(decoded) !== sha) throw new Error("Archive object checksum mismatch");
  const value = JSON.parse(decoded.toString("utf8"));
  if (value.version !== 1 || !Array.isArray(value.node)) throw new Error("Unsupported archive object");
  return value.node;
}
function fullMedia(bytes: Uint8Array, media: MediaReference) {
  if (bytes.byteLength !== media.bytes || hash(bytes) !== media.sha256) throw new Error("Timeline media checksum mismatch");
  return Buffer.from(bytes).toString("base64");
}
function missingMedia(media: MediaReference): never {
  throw Object.assign(new Error(`Media unavailable: ${media.sha256} (${media.reason ?? "expired-or-removed"})`), { code: "MEDIA_UNAVAILABLE" });
}
function joinParts(parts: any[], mode: ReadOptions["media"]) {
  // The display projection is explicit. It is never sent back to a provider.
  return parts.map(part => typeof part === "string" ? part : mode === "full" ? String(part)
    : `[media:${part.$media.sha256};${part.$media.asset ?? part.$media.reason ?? "unrecorded"}]`).join("");
}
function pathUnder(root: string, relative: string) { return join(root, relative); }
async function readUnder(root: string, relative: string) {
  const path = pathUnder(root, relative);
  if (await realpath(root) !== root || await realpath(path) !== path) throw new Error("Archive path must be canonical");
  return readFile(path);
}
function readUnderSync(root: string, relative: string) {
  const path = pathUnder(root, relative);
  if (realpathSync(root) !== root || realpathSync(path) !== path) throw new Error("Archive path must be canonical");
  return readFileSync(path);
}
function legacyPath(ref: any) {
  if (ref?.encoding !== "gzip" || !/^payloads\/[a-f0-9]{64}\.(json|bin)\.gz$/.test(ref.path)) throw new Error("Invalid legacy artifact reference");
  return ref.path;
}
async function workspaceRoot(runDir: string, explicit: string | null | undefined) {
  if (explicit === null) throw new Error("Workspace archive access is not authorized");
  const workspace = explicit ?? JSON.parse((await readUnder(runDir, "manifest.json")).toString("utf8")).workspace;
  if (typeof workspace !== "string") throw new Error("Run has no workspace archive");
  return realpath(resolve(workspace));
}
function workspaceRootSync(runDir: string, explicit: string | null | undefined) {
  if (explicit === null) throw new Error("Workspace archive access is not authorized");
  const workspace = explicit ?? JSON.parse(readUnderSync(runDir, "manifest.json").toString("utf8")).workspace;
  if (typeof workspace !== "string") throw new Error("Run has no workspace archive");
  return realpathSync(resolve(workspace));
}

export async function readArtifact(runDir: string, ref: any, options: ReadOptions = {}): Promise<any> {
  runDir = await realpath(runDir);
  if (ref?.encoding === "gzip") return JSON.parse(gunzipSync(await readUnder(runDir, legacyPath(ref))).toString("utf8"));
  verifyRef(ref);
  const workspace = await workspaceRoot(runDir, options.workspace), root = join(workspace, ".rsa", "archive");
  const mode = options.media ?? "reference";
  const decode = async (node: Node, chain: Set<string>, depth = 0): Promise<any> => {
    if (depth > 256 || !Array.isArray(node)) throw new Error("Invalid archive tree");
    switch (node[0]) {
      case "v": return node[1];
      case "a": { const out = []; for (const item of node[1]) out.push(await decode(item, chain, depth + 1)); return out; }
      case "o": { const entries: [string, any][] = []; for (const [key, item] of node[1]) entries.push([key, await decode(item, chain, depth + 1)]); return Object.fromEntries(entries); }
      case "s": { const parts = []; for (const item of node[1]) parts.push(await decode(item, chain, depth + 1)); return joinParts(parts, mode); }
      case "e": { const value = await decode(node[1], chain, depth + 1); return mode === "full" ? escapeJson(value, node[2]) : value; }
      case "r": {
        if (chain.has(node[1])) throw new Error("Cyclic archive reference");
        const next = new Set(chain); next.add(node[1]);
        return decode(parseObject(await readUnder(root, objectPath(node[1])), node[1]), next, depth + 1);
      }
      case "m": {
        if (mode !== "full") return { $media: node[1] };
        if (node[1].video) return missingMedia({ ...node[1], reason: "lossy-video-source; use the timeline frame for a visual reconstruction" });
        if (!node[1].asset) return missingMedia(node[1]);
        try { return fullMedia(await readUnder(join(workspace, ".rsa", "timeline"), mediaPath(node[1].asset)), node[1]); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingMedia(node[1]); throw error; }
      }
      default: throw new Error("Unknown archive node");
    }
  };
  return decode(ref.inline ?? parseObject(await readUnder(root, ref.path), ref.sha256), new Set([ref.sha256]));
}

/** Synchronous reader for existing offline benchmark evaluators; UI uses the async reader. */
export function readArtifactSync(runDir: string, ref: any, options: ReadOptions = {}): any {
  runDir = realpathSync(runDir);
  if (ref?.encoding === "gzip") return JSON.parse(gunzipSync(readUnderSync(runDir, legacyPath(ref))).toString("utf8"));
  verifyRef(ref);
  const workspace = workspaceRootSync(runDir, options.workspace), root = join(workspace, ".rsa", "archive");
  const mode = options.media ?? "reference";
  const decode = (node: Node, chain: Set<string>, depth = 0): any => {
    if (depth > 256 || !Array.isArray(node)) throw new Error("Invalid archive tree");
    switch (node[0]) {
      case "v": return node[1];
      case "a": return node[1].map(item => decode(item, chain, depth + 1));
      case "o": return Object.fromEntries(node[1].map(([key, item]) => [key, decode(item, chain, depth + 1)]));
      case "s": return joinParts(node[1].map(item => decode(item, chain, depth + 1)), mode);
      case "e": { const value = decode(node[1], chain, depth + 1); return mode === "full" ? escapeJson(value, node[2]) : value; }
      case "r": {
        if (chain.has(node[1])) throw new Error("Cyclic archive reference");
        const next = new Set(chain); next.add(node[1]);
        return decode(parseObject(readUnderSync(root, objectPath(node[1])), node[1]), next, depth + 1);
      }
      case "m": {
        if (mode !== "full") return { $media: node[1] };
        if (node[1].video) return missingMedia({ ...node[1], reason: "lossy-video-source; use the timeline frame for a visual reconstruction" });
        if (!node[1].asset) return missingMedia(node[1]);
        try { return fullMedia(readUnderSync(join(workspace, ".rsa", "timeline"), mediaPath(node[1].asset)), node[1]); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingMedia(node[1]); throw error; }
      }
      default: throw new Error("Unknown archive node");
    }
  };
  return decode(ref.inline ?? parseObject(readUnderSync(root, ref.path), ref.sha256), new Set([ref.sha256]));
}
