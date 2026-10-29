"use client";
import { PetSettings } from "@/components/pet-settings";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Project } from "@/lib/types";
import type { PetFollow } from "@/components/pet-follow";

/** 全局设置页：陪伴行为与控制台偏好；工作区运行信息在各自页面查看。 */
export function SettingsView({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <p className="text-sm leading-relaxed text-muted-foreground">
        陪伴显示、声音与跟随偏好的全局设置；跟随哪个工作区也可在侧栏卡片里切换。
      </p>
      <PetSettings follow={follow} projects={projects} />
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>控制台</CardTitle>
          <CardDescription>
            界面实时刷新开关仍保留在运行页头部，属于观看状态而非全局偏好；更多控制台设置集中到这里时会在此列出。
          </CardDescription>
        </CardHeader>
      </Card>
    </section>
  );
}
