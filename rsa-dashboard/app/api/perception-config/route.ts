import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
import { parsePerceptionPatch } from "@/lib/perception-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    const patch = parsePerceptionPatch(await request.json());
    const project = new URL(request.url).searchParams.get("project") ?? "";
    return Response.json(await dashboardWorker().call("updatePerceptionSettings", [project, patch], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
