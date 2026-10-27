import { mediaFile, timelineRecord, localRequest } from "@/lib/data";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    if (q.has("record")) return Response.json(await timelineRecord(q.get("project") ?? "", q.get("run") ?? "",
      q.get("record") ?? "", Number(q.get("sequence")),
      { call: q.get("call") ?? undefined, observation: q.get("id") ?? undefined }), {
      headers: { "Cache-Control": "no-store" },
    });
    const m = await mediaFile(
      q.get("project") ?? "",
      q.get("run") ?? "",
      q.get("id") ?? "",
    );
    return new Response(new Uint8Array(m.bytes), {
      headers: {
        "Content-Type": m.mediaType,
        "Cache-Control": m.cacheControl,
      },
    });
  } catch (e) {
    const error = e as Error & { status?: number; code?: string };
    return Response.json({ error: error.message, code: error.code }, {
      status: error.status ?? 404, headers: { "Cache-Control": "no-store" },
    });
  }
}
