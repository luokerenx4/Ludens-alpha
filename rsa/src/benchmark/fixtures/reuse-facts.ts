import { readArtifactSync } from "../../../../shared/log-archive.ts";

/** Freeze only the input required by the offline reuse verifier. Missing source
 * evidence remains missing; verification never falls back to a live log. */
export function freezeReuseEvents(events: any[], runDir: string): any[] {
  const relevant = new Set(["benchmark_reuse_workspace", "benchmark_reuse_phase", "benchmark_reuse_order", "benchmark_reuse_finished", "benchmark_reuse_inventory",
    "python_capabilities", "capability_start", "capability_end", "execution", "python_capability", "python_capability_result", "python_call_start", "python_call_end", "model_start", "tool_start", "tool_end", "exec", "exec_result"]);
  return events.filter(event => relevant.has(event.type)).map(event => {
    const data = { ...event.data };
    if (event.type === "tool_start" && data.argsRef) {
      try { data.args = readArtifactSync(runDir, data.argsRef, { media: "reference" }); } catch { delete data.args; }
      delete data.argsRef;
    }
    if (event.type === "tool_end" && (data.result?.encoding === "gzip" || data.result?.encoding === "rsa-json-v1")) {
      try { data.result = readArtifactSync(runDir, data.result, { media: "reference" }); } catch { delete data.result; }
    }
    // Media and assistant reasoning are not required to judge helper reuse.
    if (event.type === "tool_end" && data.result) data.result = { isError: data.result.isError, details: data.result.details };
    if (event.type === "model_start") return { seq: event.seq, origin: event.origin, type: event.type, source: event.source, trace: event.trace, data: {} };
    return { seq: event.seq, origin: event.origin, type: event.type, source: event.source, trace: event.trace, data };
  });
}
