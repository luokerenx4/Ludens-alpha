"use client";
import { useEffect, useState } from "react";
import type { CreateWorkspaceInput, WorkspaceSettings } from "../lib/workspaces";
import "./workspaces-view.css";

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
  return <div className="workspace-management" aria-busy={!!pending}>
    {error ? <div className="error-banner" role="alert">{error}</div> : null}
    {notice ? <p className="workspace-notice" role="status">{notice}</p> : null}
    {!settings ? <p>{error ? "请刷新页面重试。" : "正在读取工作区…"}</p> : <>
      <section className="surface">
        <div className="surface-heading"><h2>默认工作区目录</h2></div>
        <form onSubmit={event => { event.preventDefault(); void mutate("root", () => request("PUT", { workspaceRoot }), "默认目录已保存，仅用于之后新建的工作区。"); }}>
          <label htmlFor="workspace-root">新工作区的父目录</label>
          <div className="workspace-form-row"><input id="workspace-root" value={workspaceRoot} required
            onChange={event => setWorkspaceRoot(event.target.value)} placeholder="/完整路径/workspaces" />
            <button disabled={!!pending}>{pending === "root" ? "保存中…" : "保存"}</button></div>
          <p className="muted">更改默认目录不会搬动已有工作区或改变正在运行的实例。</p>
        </form>
      </section>
      <section className="surface">
        <div className="surface-heading"><h2>已登记的工作区</h2></div>
        {settings.workspaces.length ? <ul className="workspace-list">{settings.workspaces.map(entry => <li key={entry.id}>
          <div><strong>{entry.name}</strong><span className={entry.available ? "workspace-available" : "muted"}>{entry.available ? "可用" : "目录不可用"}</span>
            <p>{entry.workspace}</p></div>
          <div className="workspace-actions"><button disabled={!!pending || !entry.available} onClick={() => onOpen(entry.id)}>打开</button>
            <button disabled={!!pending} onClick={() => void mutate(entry.id, () => request("DELETE", { id: entry.id }), "已从列表移除，目录和运行实例均保留。")}>从列表移除</button></div>
        </li>)}</ul> : <p className="muted">尚未登记工作区。</p>}
        <form onSubmit={event => { event.preventDefault(); void mutate("register", async () => {
          await request("POST", { action: "register", workspace: existingPath }); setExistingPath("");
        }, "工作区已登记，可从列表打开。"); }}>
          <label htmlFor="workspace-existing">登记已有工作区</label>
          <div className="workspace-form-row"><input id="workspace-existing" value={existingPath} required
            onChange={event => setExistingPath(event.target.value)} placeholder="已有工作区的完整路径" />
            <button disabled={!!pending}>{pending === "register" ? "登记中…" : "登记目录"}</button></div>
          <p className="muted">目录需要包含 Ludens 工作区身份；搬动后登记新位置即可。旧版目录请先通过 CLI 的 import 命令导入。</p>
        </form>
      </section>
      <section className="surface">
        <div className="surface-heading"><h2>新建工作区</h2></div>
        <form onSubmit={event => { event.preventDefault(); void mutate("create", async () => {
          await request("POST", { action: "create", workspace: create }); setCreate({ name: "", driver: "cua" });
        }, "工作区已创建并登记。准备好设备后，可在该目录执行 rsa up。"); }}>
          <fieldset disabled={!!pending} className="workspace-fields">
            <label>名称<input value={create.name} onChange={event => setField("name", event.target.value)} required maxLength={120} placeholder="我的实验" /></label>
            <label>驱动 ID<input value={create.driver} onChange={event => setField("driver", event.target.value)} required list="workspace-drivers" /></label>
            <datalist id="workspace-drivers"><option value="cua" /><option value="mgba" /><option value="azahar" /><option value="ryubing" /></datalist>
            <label className="workspace-wide">完整目标目录（可选）<input value={create.workspace ?? ""} onChange={event => setField("workspace", event.target.value)}
              placeholder={`${settings.config.workspaceRoot}/名称`} /></label>
            <label className="workspace-wide">外部驱动包（可选）<input value={create.driverPackage ?? ""} onChange={event => setField("driverPackage", event.target.value)}
              placeholder="github:org/repo#revision 或 file:/完整路径" /></label>
            <label>游戏路径（驱动支持时）<input value={create.game ?? ""} onChange={event => setField("game", event.target.value)} /></label>
            <label>Cua 可执行文件（可选）<input value={create.cuaCommand ?? ""} onChange={event => setField("cuaCommand", event.target.value)} /></label>
          </fieldset>
          <p className="muted">外部驱动包按现有安装流程加载；请填写你信任的包地址。此操作只初始化工作区。</p>
          <button disabled={!!pending}>{pending === "create" ? "正在创建…" : "创建工作区"}</button>
        </form>
      </section>
    </>}
  </div>;
}
