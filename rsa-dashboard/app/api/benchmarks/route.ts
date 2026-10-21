import { benchmarkCatalog, benchmarkEvidence } from "@/lib/benchmark-data";
import { localRequest } from "@/lib/data";
export const dynamic = "force-dynamic";
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
        ? await benchmarkEvidence(project, run, undefined, report)
        : await benchmarkCatalog(),
    );
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
