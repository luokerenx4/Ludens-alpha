import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const id = new URL(request.url).searchParams.get("doc") ?? "";
    return Response.json(id
      ? await dashboardWorker().call("readDoc", [id], request.signal)
      : await dashboardWorker().call("docGroups", [], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
