"use client";
import { PetSettings } from "@/components/pet-settings";
import type { Project } from "@/lib/types";
import type { PetFollow } from "@/components/pet-follow";

/** 全局设置页:陪伴行为与控制台偏好;工作区运行信息在各自页面查看。 */
export function SettingsView({ follow, projects }: { follow: PetFollow; projects: Project[] }) {
  return (
    <section className="settings-page">
      <div className="settings-section">
        <h2>Ludens Pet</h2>
        <p>陪伴显示、声音与跟随偏好的全局设置;跟随哪个工作区也可在侧栏卡片里切换。</p>
        <PetSettings follow={follow} projects={projects} />
      </div>
      <div className="settings-section muted">
        <h2>控制台</h2>
        <p>界面实时刷新开关仍保留在运行页头部,属于观看状态而非全局偏好;更多控制台设置集中到这里时会在此列出。</p>
      </div>
    </section>
  );
}
