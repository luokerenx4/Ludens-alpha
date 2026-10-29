import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const params = new URL(request.url).searchParams;
    const id = params.get("doc") ?? "";
    const lang = params.get("lang") === "zh" ? "zh" : "en";
    return Response.json(id
      ? await dashboardWorker().call("readDoc", [id, undefined, lang], request.signal)
      : await dashboardWorker().call("docGroups", [], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
