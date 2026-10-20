import { expect, test } from "bun:test";
import { createTouchController } from "../src/drivers/touch.ts";
import type { Bridge } from "../src/drivers/bridge.ts";

type Request = { op: string; args: (string | number)[]; id: string };
const clock = { id: "touch-test", now: () => performance.now() };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(handle?: (request: Request) => Promise<string[]>) {
  let owner: string | undefined;
  const requests: Request[] = [];
  const bridge: Pick<Bridge, "request"> = {
    request(op, args = [], id = crypto.randomUUID()) {
      const request = { op, args, id };
      requests.push(request);
      if (op === "TOUCH_INFO") return Promise.resolve(["0", "0", "319", "239"]);
      return handle?.(request) ?? Promise.resolve(["completed"]);
    },
  };
  const controller = await createTouchController({ bridge, clock,
    acquire: async epoch => { owner = epoch; },
    release: async epoch => { if (owner === epoch) owner = undefined; },
    owns: epoch => owner === epoch,
  });
  await controller.acquire!("owner");
  return { controller, requests, context: { epoch: "owner", signal: new AbortController().signal } };
}

test("touch exposes native bounds and sends only down, move and up with unique request IDs", async () => {
  const { controller, requests, context } = await fixture();
  expect(controller.id).toBe("touch");
  expect(controller.requiresControl).toBe(true);
  expect(controller.help()).toContain("x=0..319, y=0..239");
  expect(controller.commands).toMatchObject([
    { name: "down", parameters: { properties: {
      x: { type: "integer", minimum: 0, maximum: 319 }, y: { type: "integer", minimum: 0, maximum: 239 },
    }, required: ["x", "y"] }, bindings: [
      { parameter: "x", flag: "--x", encoding: "string" }, { parameter: "y", flag: "--y", encoding: "string" },
    ] },
    { name: "move", parameters: { properties: { x: { maximum: 319 }, y: { maximum: 239 } } } },
    { name: "up", parameters: { properties: {}, additionalProperties: false }, bindings: [] },
  ]);
  const down = await controller.execute(["down", "--x", "0", "--y", "239"], context);
  await controller.execute(["move", "--x", "319", "--y", "0"], context);
  await controller.execute(["up"], context);
  expect(requests.map(({ op, args }) => [op, args])).toEqual([
    ["TOUCH_INFO", []], ["TOUCH_DOWN", ["owner", 0, 239]],
    ["TOUCH_MOVE", ["owner", 319, 0]], ["TOUCH_UP", ["owner"]],
  ]);
  expect(down.id).toBe(requests[1].id);
  expect(JSON.parse(down.stdout)).toEqual({});
  expect(new Set(requests.map(request => request.id)).size).toBe(4);
  for (const request of requests) expect(request.id).toMatch(uuid);
});

test("touch rejects invalid coordinates, extra arguments and stale ownership before sending input", async () => {
  const { controller, requests, context } = await fixture();
  for (const argv of [
    ["down", "--x", "-1", "--y", "0"], ["down", "--x", "320", "--y", "0"],
    ["move", "--x", "0", "--y", "240"], ["move", "--x", "1.5", "--y", "0"],
    ["down", "--x", "", "--y", "0"], ["down", "--x", "0"],
    ["up", "--x", "0"], ["tap", "--x", "0", "--y", "0"], ["up", "extra"],
  ]) await expect(controller.execute(argv, context)).rejects.toThrow();
  await expect(controller.execute(["up"], { ...context, epoch: "other" })).rejects.toThrow("STALE_EPOCH");
  await controller.release!("owner");
  await expect(controller.execute(["up"], context)).rejects.toThrow("STALE_EPOCH");
  expect(requests.map(request => request.op)).toEqual(["TOUCH_INFO"]);
});

test("touch waits for native sampling and lets native contact-state errors surface", async () => {
  let finish: ((fields: string[]) => void) | undefined;
  const { controller, context } = await fixture(({ op }) => {
    if (op === "TOUCH_DOWN") return new Promise(resolve => { finish = resolve; });
    return Promise.reject(new Error("NOT_DOWN"));
  });
  let settled = false;
  const pending = controller.execute(["down", "--x", "10", "--y", "20"], context)
    .then(result => { settled = true; return result; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish!(["completed"]);
  expect((await pending).status).toBe("completed");
  await expect(controller.execute(["move", "--x", "10", "--y", "20"], context)).rejects.toThrow("NOT_DOWN");
});

test("touch cancellation targets its command ID and retains the shared owner", async () => {
  let finish: ((fields: string[]) => void) | undefined;
  const { controller, requests, context } = await fixture(({ op }) => {
    if (op === "TOUCH_DOWN") return new Promise(resolve => { finish = resolve; });
    if (op === "STOP") finish!(["interrupted"]);
    return Promise.resolve(["completed"]);
  });
  const abort = new AbortController();
  const pending = controller.execute(["down", "--x", "10", "--y", "20"], { ...context, signal: abort.signal });
  abort.abort();
  const result = await pending;
  expect(result.status).toBe("interrupted");
  expect(result.exitCode).toBe(130);
  const down = requests.find(request => request.op === "TOUCH_DOWN")!;
  const stop = requests.find(request => request.op === "STOP")!;
  expect(stop.args).toEqual(["owner", down.id]);
  expect(stop.id).toMatch(uuid);
  expect(stop.id).not.toBe(down.id);
  await controller.execute(["up"], context);
  expect(requests.some(request => request.op === "DISOWN")).toBe(false);
});
