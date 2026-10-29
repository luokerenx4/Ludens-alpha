import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    localRequest(request);
    return Response.json(await dashboardWorker().call("workspaceSettings", [], request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("无效的工作区操作");
    const worker = dashboardWorker();
    if (body.action === "register") return Response.json(await worker.call("openWorkspace", [body.workspace], request.signal));
    if (body.action === "create") return Response.json(await worker.call("createWorkspace", [body.workspace], request.signal));
    throw new Error("未知的工作区操作");
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    return Response.json(await dashboardWorker().call("updateWorkspaceRoot", [body?.workspaceRoot], request.signal));
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    return Response.json(await dashboardWorker().call("removeWorkspace", [body?.id], request.signal));
  } catch (error) { return errorResponse(error); }
}
