import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

const hash = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
export interface SkillIndex {
  version: string;
  skills: { name: string; description: string; path: string; version: string }[];
  memory: { version: string; files: { path: string; version: string; bytes: number }[] };
  diagnostics: string[];
}

export class Workspace {
  private saved = new Set<string>();
  constructor(readonly path: string, readonly versions: string) {}

  private async save(filename: string, data: string | Uint8Array): Promise<void> {
    if (!this.saved.has(filename)) {
      await writeFile(join(this.versions, filename), data);
      this.saved.add(filename);
    }
  }

  private async saveManifest(files: Record<string, string>) {
    const manifest = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
    const version = hash(JSON.stringify(manifest));
    await this.save(`${version}.json`, JSON.stringify(manifest, null, 2));
    return { manifest, version };
  }

  async snapshot(): Promise<SkillIndex> {
    await mkdir(this.versions, { recursive: true });
    const files: Record<string, string> = {};
    const contents = new Map<string, string>();
    for await (const file of new Bun.Glob("skills/**/*").scan({ cwd: this.path, onlyFiles: true, dot: true })) {
      const data = await readFile(join(this.path, file));
      const version = hash(data);
      files[file] = version;
      await this.save(version, data);
      if (/^skills\/[^/]+\/SKILL\.md$/.test(file)) contents.set(file, data.toString("utf8"));
    }
    const { manifest, version } = await this.saveManifest(files);
    const skills: SkillIndex["skills"] = [];
    const diagnostics: string[] = [];
    for (const [file, text] of contents) {
      try {
        const { frontmatter } = parseFrontmatter(text, { source: file, repair: false, level: "off" });
        const { name, description } = frontmatter;
        if (typeof name !== "string" || typeof description !== "string" || !name.trim() || !description.trim()) throw new Error("SKILL.md needs name and description frontmatter");
        const directory = file.slice(0, -"SKILL.md".length);
        const skillVersion = hash(JSON.stringify(Object.entries(manifest).filter(([p]) => p.startsWith(directory))));
        skills.push({ name, description, path: join(this.path, file), version: skillVersion });
      } catch (error) { diagnostics.push(`${file}: ${error}`); }
    }
    const memoryManifest: Record<string, string> = {};
    const memoryFiles: SkillIndex["memory"]["files"] = [];
    for await (const file of new Bun.Glob("memory/**/*").scan({ cwd: this.path, onlyFiles: true, dot: true })) {
      const data = await readFile(join(this.path, file));
      const version = hash(data);
      memoryManifest[file] = version;
      await this.save(version, data);
      memoryFiles.push({ path: join(this.path, file), version, bytes: data.byteLength });
    }
    const { version: memoryVersion } = await this.saveManifest(memoryManifest);
    const memory = { version: memoryVersion, files: memoryFiles.sort((a, b) => a.path.localeCompare(b.path)) };
    return { version, skills: skills.sort((a, b) => a.path.localeCompare(b.path)), memory, diagnostics };
  }
}
