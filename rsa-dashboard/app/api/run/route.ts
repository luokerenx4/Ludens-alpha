import { getRun, localRequest } from "@/lib/data";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams;
    return Response.json(
      await getRun(
        q.get("project") ?? "",
        q.get("run") ?? "",
        q.get("epoch") ?? undefined,
      ),
    );
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
