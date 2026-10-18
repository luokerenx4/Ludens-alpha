import { getActivity } from "@/lib/activity";
import { localRequest } from "@/lib/data";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const query = new URL(request.url).searchParams;
    return Response.json(await getActivity(query.get("project") ?? "", query.get("run") ?? "", query.get("epoch") ?? undefined));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
