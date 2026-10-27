import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const b = await request.json();
    if (b.action !== "off") throw new Error("仅支持交还控制权");
    return Response.json(await dashboardWorker().call("stop", [b.project, b.run, b.epoch], request.signal));
  } catch (e) {
    return errorResponse(e, 409);
  }
}
