import { parseArgs } from "node:util";
import type { Clock, Controller } from "../contracts.ts";
import type { Bridge } from "./bridge.ts";

/** A single native contact. Gesture composition and screen mapping belong to the caller. */
export async function createTouchController(options: {
  bridge: Pick<Bridge, "request">;
  clock: Clock;
  acquire(epoch: string): Promise<void>;
  release(epoch: string): Promise<void>;
  owns(epoch: string): boolean;
}): Promise<Controller> {
  const { bridge, clock } = options;
  const range = (await bridge.request("TOUCH_INFO", [], crypto.randomUUID())).map(Number);
  const [minX, minY, maxX, maxY] = range;
  if (range.length !== 4 || !range.every(Number.isSafeInteger) || minX > maxX || minY > maxY) {
    throw new Error("Invalid native touch coordinate range");
  }
  return {
    id: "touch", requiresControl: true,
    acquire: options.acquire, release: options.release,
    help: () => `Single-contact touchscreen, in native device coordinates.
Coordinates are integers: x=${minX}..${maxX}, y=${minY}..${maxY}, inclusive.
Origin is the top-left; +x points right and +y points down.
down --x <integer> --y <integer>
move --x <integer> --y <integer>
up
down starts a contact and fails if one is already down. move requires a contact.
up ends the contact. Commands complete after the device samples the new state.
The contact persists between commands. Cancellation and releasing control lift it.
No display scaling or screenshot coordinate conversion is applied.`,
    async execute(argv, { epoch, signal }) {
      signal.throwIfAborted();
      if (!epoch || !options.owns(epoch)) throw new Error("STALE_EPOCH");
      const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true,
        options: { x: { type: "string" }, y: { type: "string" } } });
      const [command] = positionals;
      if (positionals.length !== 1 || !["down", "move", "up"].includes(command)) {
        throw new Error("Expected down, move or up; see --help");
      }
      let coordinates: number[] = [];
      if (command === "up") {
        if (values.x !== undefined || values.y !== undefined) throw new Error("up does not take coordinates");
      } else {
        coordinates = [values.x, values.y].map((value, axis) => {
          const coordinate = Number(value);
          const min = axis === 0 ? minX : minY;
          const max = axis === 0 ? maxX : maxY;
          if (!value?.trim() || !Number.isSafeInteger(coordinate) || coordinate < min || coordinate > max) {
            throw new Error(`${axis === 0 ? "x" : "y"} must be an integer from ${min} to ${max}`);
          }
          return coordinate;
        });
      }
      const id = crypto.randomUUID();
      const requestedAtMs = clock.now();
      signal.throwIfAborted();
      const pending = bridge.request(`TOUCH_${command.toUpperCase()}`, [epoch, ...coordinates], id);
      const abort = () => { void bridge.request("STOP", [epoch, id], crypto.randomUUID()).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const [outcome] = await pending;
        const status = outcome as "completed" | "interrupted";
        return { id, status, exitCode: status === "completed" ? 0 : 130,
          stdout: "{}", stderr: "",
          timing: { clock: clock.id, requestedAtMs, receivedAtMs: clock.now() } };
      } finally { signal.removeEventListener("abort", abort); }
    },
  };
}
