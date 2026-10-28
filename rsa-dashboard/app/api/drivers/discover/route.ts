import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    localRequest(request);
    const spec = new URL(request.url).searchParams.get("spec") ?? "";
    return Response.json(await dashboardWorker().call("discoverDriver", [spec], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
