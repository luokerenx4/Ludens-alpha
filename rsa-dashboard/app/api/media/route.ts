import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    if (q.has("record")) return Response.json(await dashboardWorker().call("timelineRecord", [q.get("project") ?? "", q.get("run") ?? "",
      q.get("record") ?? "", Number(q.get("sequence")),
      { call: q.get("call") ?? undefined, observation: q.get("id") ?? undefined }], request.signal), {
      headers: { "Cache-Control": "no-store" },
    });
    const m = await dashboardWorker().call("media", [
      q.get("project") ?? "",
      q.get("run") ?? "",
      q.get("id") ?? "",
    ], request.signal);
    return new Response(new Uint8Array(m.bytes), {
      headers: {
        "Content-Type": m.mediaType,
        "Cache-Control": m.cacheControl,
      },
    });
  } catch (e) {
    return errorResponse(e, 404);
  }
}
