import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const includeEmpty = new URL(request.url).searchParams.get("includeEmpty") === "1";
    return Response.json(await dashboardWorker().call("catalog", [includeEmpty], request.signal));
  } catch (e) {
    return errorResponse(e);
  }
}
