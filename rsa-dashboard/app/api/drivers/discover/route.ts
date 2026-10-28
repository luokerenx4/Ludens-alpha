import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("spec" in body) || typeof body.spec !== "string") {
      throw new Error("驱动包地址必须是字符串");
    }
    return Response.json(await dashboardWorker().call("discoverDriver", [body.spec], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
