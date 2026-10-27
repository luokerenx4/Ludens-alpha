import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { readArtifact } from "../../../shared/log-archive.ts";
import { once } from "node:events";
import { readRunEvents } from "../../../shared/event-sources.ts";

export const LOG_HELP = `rsa logs events --run <run-directory> [--diagnostics]
Stream saved events as NDJSON, resolving registered device sources without copying them.
--diagnostics explicitly reads the separate diagnostic channel.
rsa logs read --run <run-directory> (--ref '<JSON reference>' | --file <reference.json> | --event <seq> --field <name>) [--full]
Read a stored model/tool artifact offline; no host or model is started.
Default: expand text/structure and keep media references. --full restores recorded media
as base64; missing, unrecorded or expired media fails explicitly. HTTP wire hashes describe
the original body; reconstructed JSON does not reproduce compressed wire bytes.
Event fields include payload, response, result, resultRef, body and argsRef. Old gzip artifacts remain readable.`;

export async function logCommand(argv: string[]) {
  if (!argv.length || argv.includes("--help")) { console.log(LOG_HELP); return; }
  if (argv[0] === "events") {
    const { values } = parseArgs({ args: argv.slice(1), options: { run: { type: "string" }, diagnostics: { type: "boolean" } } });
    if (!values.run) throw new Error("--run is required");
    for await (const event of readRunEvents(await realpath(values.run), { channel: values.diagnostics ? "diagnostics" : "events" })) {
      if (!process.stdout.write(JSON.stringify(event) + "\n")) await once(process.stdout, "drain");
    }
    return;
  }
  if (argv[0] !== "read") throw new Error("Expected rsa logs read; see rsa logs --help");
  const { values } = parseArgs({ args: argv.slice(1), options: {
    run: { type: "string" }, ref: { type: "string" }, file: { type: "string" },
    event: { type: "string" }, field: { type: "string" }, full: { type: "boolean" },
  } });
  if (!values.run || [values.ref, values.file, values.event].filter(value => value !== undefined).length !== 1)
    throw new Error("Supply --run and exactly one of --ref, --file or --event");
  const run = await realpath(values.run);
  let reference: unknown;
  if (values.event !== undefined) {
    const sequence = Number(values.event);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !values.field) throw new Error("--event requires a positive sequence and --field");
    const input = createReadStream(join(run, "events.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.seq === sequence) { reference = event.data?.[values.field]; break; }
      }
    } finally { lines.close(); input.destroy(); }
    if (reference === undefined) throw new Error("Event or artifact field was not found");
  } else {
    if (values.field !== undefined) throw new Error("--field requires --event");
    reference = JSON.parse(values.ref ?? await readFile(values.file!, "utf8"));
  }
  console.log(JSON.stringify(await readArtifact(run, reference, { media: values.full ? "full" : "reference" }), null, 2));
}
