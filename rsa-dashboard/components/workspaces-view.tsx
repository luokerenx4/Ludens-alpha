"use client";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateWorkspaceInput, WorkspaceSettings } from "../lib/workspaces";

async function request<T>(method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/workspaces", { method, signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "工作区操作失败");
  return value;
}

export function WorkspacesView({ onChanged, onOpen }: { onChanged(): void; onOpen(id: string): void }) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [existingPath, setExistingPath] = useState("");
  const [create, setCreate] = useState<CreateWorkspaceInput>({ name: "", driver: "cua" });
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void request<WorkspaceSettings>("GET", undefined, controller.signal).then(value => {
      setSettings(value); setWorkspaceRoot(value.config.workspaceRoot);
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, []);
  const mutate = async (label: string, operation: () => Promise<unknown>, message: string) => {
    setPending(label); setError(""); setNotice("");
    try {
      await operation();
      const value = await request<WorkspaceSettings>();
      setSettings(value); setWorkspaceRoot(value.config.workspaceRoot);
      onChanged(); setNotice(message);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(""); }
  };
  const setField = (name: keyof CreateWorkspaceInput, value: string) => setCreate(previous => ({ ...previous, [name]: value }));
  return (
    <div className="grid max-w-5xl gap-5" aria-busy={!!pending}>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {notice ? <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      {!settings ? <p className="text-sm text-muted-foreground">{error ? "请刷新页面重试。" : "正在读取工作区…"}</p> : <>
        <Card>
          <CardHeader><CardTitle><h2 className="text-base font-semibold">默认工作区目录</h2></CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={event => {
              event.preventDefault();
              void mutate("root", () => request("PUT", { workspaceRoot }), "默认目录已保存，仅用于之后新建的工作区。");
            }}>
              <Label htmlFor="workspace-root">新工作区的父目录</Label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input id="workspace-root" value={workspaceRoot} required aria-describedby="workspace-root-hint"
                  onChange={event => setWorkspaceRoot(event.target.value)} placeholder="/完整路径/workspaces" />
                <Button type="submit" disabled={!!pending}>{pending === "root" ? "保存中…" : "保存"}</Button>
              </div>
              <p id="workspace-root-hint" className="text-xs leading-relaxed text-muted-foreground">更改默认目录不会搬动已有工作区或改变正在运行的实例。</p>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle><h2 className="text-base font-semibold">已登记的工作区</h2></CardTitle></CardHeader>
          <CardContent className="grid gap-6">
            {settings.workspaces.length ? <ul className="divide-y divide-border">
              {settings.workspaces.map(entry => <li key={entry.id} className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <strong className="text-sm font-medium">{entry.name}</strong>
                    <Badge variant={entry.available ? "secondary" : "outline"}>{entry.available ? "可用" : "目录不可用"}</Badge>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{entry.workspace}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" size="sm" disabled={!!pending || !entry.available} onClick={() => onOpen(entry.id)}>打开</Button>
                  <Button type="button" size="sm" variant="outline" disabled={!!pending} onClick={() => void mutate(entry.id, () => request("DELETE", { id: entry.id }), "已从列表移除，目录和运行实例均保留。")}>从列表移除</Button>
                </div>
              </li>)}
            </ul> : <p className="text-sm text-muted-foreground">尚未登记工作区。</p>}
            <form className="grid gap-3 border-t pt-6" onSubmit={event => {
              event.preventDefault();
              void mutate("register", async () => {
                await request("POST", { action: "register", workspace: existingPath }); setExistingPath("");
              }, "工作区已登记，可从列表打开。");
            }}>
              <Label htmlFor="workspace-existing">登记已有工作区</Label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input id="workspace-existing" value={existingPath} required aria-describedby="workspace-existing-hint"
                  onChange={event => setExistingPath(event.target.value)} placeholder="已有工作区的完整路径" />
                <Button type="submit" variant="secondary" disabled={!!pending}>{pending === "register" ? "登记中…" : "登记目录"}</Button>
              </div>
              <p id="workspace-existing-hint" className="text-xs leading-relaxed text-muted-foreground">目录需要包含 Ludens 工作区身份；搬动后登记新位置即可。旧版目录请先通过 CLI 的 import 命令导入。</p>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle><h2 className="text-base font-semibold">新建工作区</h2></CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-5" onSubmit={event => {
              event.preventDefault();
              void mutate("create", async () => {
                await request("POST", { action: "create", workspace: create }); setCreate({ name: "", driver: "cua" });
              }, "工作区已创建并登记。准备好设备后，可在该目录执行 rsa up。");
            }}>
              <fieldset disabled={!!pending} className="grid min-w-0 gap-5 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="workspace-name">名称</Label>
                  <Input id="workspace-name" value={create.name} onChange={event => setField("name", event.target.value)} required maxLength={120} placeholder="我的实验" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="workspace-driver">驱动 ID</Label>
                  <Input id="workspace-driver" value={create.driver} onChange={event => setField("driver", event.target.value)} required list="workspace-drivers" />
                  <datalist id="workspace-drivers"><option value="cua" /><option value="mgba" /><option value="azahar" /><option value="ryubing" /></datalist>
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="workspace-target">完整目标目录（可选）</Label>
                  <Input id="workspace-target" value={create.workspace ?? ""} onChange={event => setField("workspace", event.target.value)} placeholder={`${settings.config.workspaceRoot}/名称`} />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="workspace-driver-package">外部驱动包（可选）</Label>
                  <Input id="workspace-driver-package" value={create.driverPackage ?? ""} onChange={event => setField("driverPackage", event.target.value)}
                    aria-describedby="workspace-create-hint" placeholder="github:org/repo#revision 或 file:/完整路径" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="workspace-game">游戏路径（驱动支持时）</Label>
                  <Input id="workspace-game" value={create.game ?? ""} onChange={event => setField("game", event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="workspace-cua-command">Cua 可执行文件（可选）</Label>
                  <Input id="workspace-cua-command" value={create.cuaCommand ?? ""} onChange={event => setField("cuaCommand", event.target.value)} />
                </div>
              </fieldset>
              <p id="workspace-create-hint" className="text-xs leading-relaxed text-muted-foreground">外部驱动包按现有安装流程加载；请填写你信任的包地址。此操作只初始化工作区。</p>
              <Button type="submit" className="justify-self-start" disabled={!!pending}>{pending === "create" ? "正在创建…" : "创建工作区"}</Button>
            </form>
          </CardContent>
        </Card>
      </>}
    </div>
  );
}
