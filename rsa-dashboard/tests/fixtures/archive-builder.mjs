import { mkdirSync } from "node:fs";
let timer;
process.on("disconnect", () => process.exit(1));
process.on("SIGTERM", () => process.exit(0));
process.on("message", message => {
  if (message.type === "cancel") return process.exit(0);
  mkdirSync(message.directory, { recursive: true });
  if (process.env.BUILDER_FIXTURE_FAIL) {
    process.send({ type: "error", message: "fixture build failed" }, () => process.exit(1));
    return;
  }
  process.send({ type: "progress", value: { stage: "fixture", bytes: 1, totalBytes: 2 } });
  timer = setInterval(() => {}, 1000);
});
