import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    localRequest(request);
    const query = new URL(request.url).searchParams;
    const project = query.get("project") ?? "", workspace = query.get("workspace") ?? "";
    return Response.json(await dashboardWorker().call("perceptionRuntime", [project, workspace], request.signal),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
