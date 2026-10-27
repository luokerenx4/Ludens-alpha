import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const params = new URL(request.url).searchParams;
    const project = params.get("project"),
      run = params.get("run"),
      report = params.get("report") ?? undefined;
    if (!!project !== !!run) throw new Error("证据查询需要 project 和 run");
    if (report && (!project || !run))
      throw new Error("报告查询需要 project 和 run");
    return Response.json(
      project && run
        ? await dashboardWorker().call("benchmarkEvidence", [project, run, report], request.signal)
        : await dashboardWorker().call("benchmarkCatalog", [], request.signal),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
