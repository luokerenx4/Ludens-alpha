import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
import { parseBenchmarkRequest } from "@/lib/benchmarks";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const selection = parseBenchmarkRequest(new URL(request.url).searchParams);
    return Response.json(selection.kind === "attachment"
      ? await dashboardWorker().call("benchmarkAttachment", [selection.project, selection.run, selection.index, selection.verification], request.signal)
      : selection.kind === "detail"
      ? await dashboardWorker().call("benchmarkEvidence", [selection.project, selection.run, selection.query], request.signal)
      : await dashboardWorker().call("benchmarkCatalog", [selection.query], request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
