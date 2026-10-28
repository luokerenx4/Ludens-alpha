import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const project = new URL(request.url).searchParams.get("project") ?? undefined;
    return Response.json(await dashboardWorker().call("capabilities", [project], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
