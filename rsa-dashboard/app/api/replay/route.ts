import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
import type { ReplayQuery } from "@/lib/replay";
import { fileResponse } from "@/lib/file-response";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    const result = await dashboardWorker().call("replay", [q.get("project") ?? "", q.get("run") ?? "", {
      mode: (q.get("mode") ?? "overview") as ReplayQuery["mode"], epoch: q.get("epoch") ?? undefined,
      start: q.has("start") ? Number(q.get("start")) : undefined, end: q.has("end") ? Number(q.get("end")) : undefined,
      cursor: q.get("cursor") ?? undefined, id: q.get("id") ?? undefined, record: q.get("record") ?? undefined,
      sequence: q.has("sequence") ? Number(q.get("sequence")) : undefined, media: q.has("media") ? Number(q.get("media")) : undefined,
      asset: q.get("asset") ?? undefined,
      bytes: q.has("bytes") ? Number(q.get("bytes")) : undefined,
    }], request.signal);
    if ("file" in result) return await fileResponse(request, result);
    if ("bytes" in result) return new Response(new Uint8Array(result.bytes), {
      headers: { "Content-Type": result.mediaType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
export const HEAD = GET;
