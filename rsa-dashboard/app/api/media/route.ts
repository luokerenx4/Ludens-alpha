import { mediaFile, localRequest } from "@/lib/data";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    const m = await mediaFile(
      q.get("project") ?? "",
      q.get("run") ?? "",
      q.get("id") ?? "",
    );
    return new Response(new Uint8Array(m.bytes), {
      headers: {
        "Content-Type": m.mediaType,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 404 });
  }
}
