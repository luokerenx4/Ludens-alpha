import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
import { PERCEPTION_LIMITS, type PerceptionSettings } from "@/lib/perception-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KEYS = Object.keys(PERCEPTION_LIMITS) as (keyof PerceptionSettings)[];

export async function GET(request: Request) {
  try {
    localRequest(request);
    const project = new URL(request.url).searchParams.get("project") ?? "";
    return Response.json(await dashboardWorker().call("perceptionSettings", [project], request.signal),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    localRequest(request, true);
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("设置必须是 JSON 对象");
    const patch: Partial<PerceptionSettings> = {};
    for (const key of KEYS) if ((input as Record<string, unknown>)[key] !== undefined) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value !== "number" || !Number.isInteger(value))
        throw new Error("设置值必须是整数秒");
      patch[key] = value;
    }
    const unknown = Object.keys(input as Record<string, unknown>).filter((key) => !KEYS.includes(key as keyof PerceptionSettings));
    if (unknown.length) throw new Error("未知的工作区设置: " + unknown.join(", "));
    const project = new URL(request.url).searchParams.get("project") ?? "";
    return Response.json(await dashboardWorker().call("updatePerceptionSettings", [project, patch], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
