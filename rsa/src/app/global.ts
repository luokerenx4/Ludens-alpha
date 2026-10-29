import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { forgetWorkspace, listRegisteredWorkspaces, ludensHome, readGlobalConfig, readWorkspaceIdentity,
  registerWorkspace, renewWorkspaceIdentity, updateGlobalConfig } from "../../../shared/ludens.ts";

export const GLOBAL_HELP = `Ludens settings and workspace registry:
rsa config [show]
rsa config set workspaceRoot <directory>
rsa config set defaults.<model|seconds|requests|compactionThreshold|dashboard|pet> <value>
rsa workspace list
rsa workspace open <directory> [--new-id]
rsa workspace forget <id>
rsa workspace import <directory> [--legacy-state <directory>] [--previous-workspace <directory>]

LUDENS_HOME selects the global directory (default ~/.ludens).
New workspaces use its configured workspaceRoot; existing workspace settings do not change.
open registers an existing workspace; forget removes only its registry entry.
--new-id makes a copied directory independent and starts a new session, retaining archived history.
import explicitly brings old workspace sessions and skill versions into the workspace.
Stop the workspace's host and Baseware before import or --new-id; the emulator can remain open.`;

function directory(value: string) {
  if (!value.trim()) throw new Error("Directory must not be empty");
  return resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}
/** Read-only probe; never take over or stop a running workspace. */
async function assertInactive(workspace: string) {
  const hash = createHash("sha256").update(workspace).digest("hex").slice(0, 16);
  for (const service of ["rsa", "baseware"]) {
    const path = `/tmp/ludens-${service}-${process.getuid?.() ?? "user"}-${hash}.sock`;
    await new Promise<void>((accept, reject) => {
      const socket = connect(path);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Cannot confirm workspace is stopped: ${path}`)); }, 1000);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error(`Workspace is running (${service}); stop its host and Baseware first.`)); });
      socket.once("error", error => {
        clearTimeout(timer); socket.destroy();
        if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) accept(); else reject(error);
      });
    });
  }
}

export async function globalCommand(command: string, args: string[], home = ludensHome()) {
  if (args.includes("--help")) { console.log(GLOBAL_HELP); return; }
  if (command === "config") {
    const [action = "show", field, value, ...extra] = args;
    if (action === "show" && !field) { console.log(JSON.stringify({ home, ...await readGlobalConfig(home) }, null, 2)); return; }
    if (action !== "set" || !field || value === undefined || extra.length) throw new Error("Use rsa config set <field> <value>");
    const config = await updateGlobalConfig(config => {
      if (field === "workspaceRoot") config.workspaceRoot = directory(value);
      else if (field.startsWith("defaults.")) {
        const key = field.slice("defaults.".length);
        const setting = key === "model" ? value : ["pet", "dashboard"].includes(key)
          ? value === "true" ? true : value === "false" ? false : value : Number(value);
        config.defaults = { ...config.defaults, [key]: setting };
      } else throw new Error(`Unknown global setting: ${field}`);
      return config;
    }, home);
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  const [action, ...rest] = args;
  if (action === "list" && !rest.length) { console.log(JSON.stringify(await listRegisteredWorkspaces(home), null, 2)); return; }
  if (action === "forget" && rest.length === 1) {
    await forgetWorkspace(rest[0]!, home);
    console.log(JSON.stringify({ forgotten: rest[0] })); return;
  }
  if (action !== "open" && action !== "import") throw new Error("Use rsa workspace list | open <directory> | forget <id> | import <directory>");
  const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: action === "open"
    ? { "new-id": { type: "boolean" } }
    : { "legacy-state": { type: "string" }, "previous-workspace": { type: "string" } } });
  if (positionals.length !== 1) throw new Error(`workspace ${action} requires one directory`);
  const workspace = await realpath(directory(positionals[0]!));
  let imported: unknown;
  if (action === "import") {
    // Import creates identity, so require an explicit workspace configuration.
    const config = JSON.parse(await readFile(join(workspace, "rsa.json"), "utf8"));
    if (!config || typeof config.driver !== "string" || !config.driver.trim()) throw new Error("Workspace import requires rsa.json with a driver");
    await assertInactive(workspace);
    const previousPath = typeof values["previous-workspace"] === "string" ? directory(values["previous-workspace"]) : undefined;
    const previousWorkspace = previousPath ? await realpath(previousPath).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return previousPath;
    }) : undefined;
    if (previousWorkspace && previousWorkspace !== workspace) await assertInactive(previousWorkspace);
    const { importLegacyWorkspaceState } = await import("../harness/omp/workspace-session.ts");
    imported = await importLegacyWorkspaceState(workspace, {
      globalHome: home,
      ...(typeof values["legacy-state"] === "string" ? { legacyStateDir: directory(values["legacy-state"]) } : {}),
      ...(previousWorkspace ? { previousWorkspace } : {}),
    });
  } else {
    await readWorkspaceIdentity(workspace).catch(error => {
      if (error.code === "ENOENT") throw new Error("Workspace has no Ludens identity; use rsa workspace import <directory> for an existing workspace");
      throw error;
    });
    if (values["new-id"]) { await assertInactive(workspace); await renewWorkspaceIdentity(workspace, home); }
  }
  console.log(JSON.stringify({ ...await registerWorkspace(workspace, home), ...(imported ? { import: imported } : {}) }, null, 2));
}
