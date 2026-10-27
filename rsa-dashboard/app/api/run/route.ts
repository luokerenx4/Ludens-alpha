import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    const beforeCall = q.has("beforeCall") ? Number(q.get("beforeCall")) : undefined;
    if (beforeCall !== undefined && (!Number.isSafeInteger(beforeCall) || beforeCall < 1)) throw new Error("无效的请求分页位置");
    return Response.json(
      await dashboardWorker().call("run", [
        q.get("project") ?? "",
        q.get("run") ?? "",
        q.get("epoch") ?? undefined,
        { beforeCall, call: q.get("call") ?? undefined, image: q.get("image") ?? undefined },
      ], request.signal),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
