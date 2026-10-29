"use client";
import { LoopLab } from "@/components/loop-lab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
    <Tabs value={panel} onValueChange={id => navigate({ panel: id })} className="gap-4">
      <TabsList aria-label="开发者面板">
        {(Object.keys(panels) as PanelId[]).map(id => (
          <TabsTrigger
            key={id}
            value={id}
          >
            {panels[id].title}
          </TabsTrigger>
        ))}
      </TabsList>
      {(Object.keys(panels) as PanelId[]).map(id => (
        <TabsContent key={id} value={id}>{panels[id].render()}</TabsContent>
      ))}
    </Tabs>
  );
}
