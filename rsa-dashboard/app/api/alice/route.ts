import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return Response.json(await dashboardWorker().call("aliceState", [], request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PUT(request: Request) {
  try {
    localRequest(request, true);
    const input = await request.json();
    return Response.json(await dashboardWorker().call("aliceTarget", [input.project, input.ifUnset === true], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    return Response.json(await dashboardWorker().call("aliceConsumer", [await request.json()], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
