import { getActivity, type ActivityQuery } from "@/lib/activity";
import { localRequest } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const query = new URL(request.url).searchParams;
    const mode = query.get("mode") ?? "changes";
    if (!["changes", "history", "block"].includes(mode)) throw new Error("无效的日志查询模式");
    return Response.json(await getActivity(query.get("project") ?? "", query.get("run") ?? undefined,
      query.get("epoch") ?? undefined, { mode: mode as ActivityQuery["mode"], cursor: query.get("cursor") ?? undefined,
        before: query.get("before") ?? undefined, kind: query.get("kind") ?? undefined, q: query.get("q") ?? undefined,
        id: query.get("id") ?? undefined, limit: query.has("limit") ? Number(query.get("limit")) : undefined }, request.signal));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
