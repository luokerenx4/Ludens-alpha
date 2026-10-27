import { dashboardWorker } from "@/lib/dashboard-worker";
import { localRequest, errorResponse } from "@/lib/local-request";
import type { DiagnosticQuery } from "@/lib/diagnostic-events";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    localRequest(request);
    const q = new URL(request.url).searchParams, query: DiagnosticQuery = {};
    for (const key of ["afterPosition", "limit"] as const) if (q.has(key)) {
      const value = Number(q.get(key));
      if (!Number.isSafeInteger(value) || value < (key === "limit" ? 1 : 0)) throw new Error("无效的诊断分页参数");
      query[key] = value;
    }
    for (const key of ["epoch", "fromAt", "toAt", "traceId", "spanId", "actionId", "observationId"] as const)
      if (q.has(key)) query[key] = q.get(key)!;
    return Response.json(await dashboardWorker().call("diagnosticEvents", [q.get("project") ?? "", q.get("run") ?? "", query], request.signal));
  } catch (error) { return errorResponse(error); }
}
