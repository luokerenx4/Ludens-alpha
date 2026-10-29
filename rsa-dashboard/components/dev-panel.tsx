"use client";
import { LoopLab } from "@/components/loop-lab";

const panels = {
  loop: { title: "Loop 实验", render: () => <LoopLab /> },
} as const;
type PanelId = keyof typeof panels;

/** 开发者面板:原理展示工具的容器,不影响任何真实运行。 */
export function DevPanel({ navigate }: { navigate: (patch: Record<string, string | null>) => void }) {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("panel");
  const panel: PanelId = requested && requested in panels ? (requested as PanelId) : "loop";
  return (
    <section className="dev-panel">
      <nav className="benchmark-tabs panel-tabs" aria-label="开发者面板">
        {(Object.keys(panels) as PanelId[]).map(id => (
          <button
            key={id}
            aria-pressed={panel === id}
            className={panel === id ? "active" : ""}
            onClick={() => navigate({ panel: id })}
          >
            {panels[id].title}
          </button>
        ))}
      </nav>
      {panels[panel].render()}
    </section>
  );
}
