import { stopRun, localRequest } from "@/lib/data";
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    const b = await request.json();
    if (b.action !== "off") throw new Error("仅支持交还控制权");
    return Response.json(await stopRun(b.project, b.run, b.epoch));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 409 });
  }
}
