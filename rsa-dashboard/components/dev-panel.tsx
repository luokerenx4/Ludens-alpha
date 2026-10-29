"use client";
import { LoopLab } from "@/components/loop-lab";

/** Local mechanics explainer. Navigation never applies a real workspace setting. */
export function DevPanel({ navigate }: { navigate: (patch: Record<string, string | null>) => void }) {
  return <LoopLab navigate={navigate} />;
}
