import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return Response.json(await dashboardWorker().call("catalog", [], request.signal));
  } catch (e) {
    return errorResponse(e);
  }
}
