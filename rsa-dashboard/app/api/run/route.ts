import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    if (q.get("build") === "state") return Response.json(await dashboardWorker().call("archiveBuild",
      [q.get("project") ?? "", q.get("run") ?? ""], request.signal));
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
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const body = await request.json();
    if (typeof body.project !== "string" || typeof body.run !== "string" || typeof body.buildId !== "string"
      || !body.buildId || (body.action !== "cancel" && body.action !== "retry"))
      throw new Error("无效的目录构建操作");
    return Response.json(await dashboardWorker().call("archiveBuild",
      [body.project, body.run, body.action, body.buildId], request.signal));
  } catch (error) { return errorResponse(error, 409); }
}
