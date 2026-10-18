import { catalog, localRequest } from "@/lib/data";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return Response.json(await catalog());
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
