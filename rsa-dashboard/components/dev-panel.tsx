"use client";
import { LoopLab } from "@/components/loop-lab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslations } from "@/lib/locale";

const panels = {
  loop: { titleKey: "loopTitle", render: () => <LoopLab /> },
} as const;
type PanelId = keyof typeof panels;

/** Developer panel: container for mechanics explainer tools; never affects real runs. */
export function DevPanel({ navigate }: { navigate: (patch: Record<string, string | null>) => void }) {
  const t = useTranslations("devPanel");
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("panel");
  const panel: PanelId = requested && requested in panels ? (requested as PanelId) : "loop";
  return (
    <Tabs value={panel} onValueChange={id => navigate({ panel: id })} className="gap-4">
      <TabsList aria-label={t("tabsLabel")}>
        {(Object.keys(panels) as PanelId[]).map(id => (
          <TabsTrigger
            key={id}
            value={id}
          >
            {t(panels[id].titleKey)}
          </TabsTrigger>
        ))}
      </TabsList>
      {(Object.keys(panels) as PanelId[]).map(id => (
        <TabsContent key={id} value={id}>{panels[id].render()}</TabsContent>
      ))}
    </Tabs>
  );
}
