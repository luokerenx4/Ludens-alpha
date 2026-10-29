"use client";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreateWorkspaceInput, WorkspaceSettings } from "../lib/workspaces";
import { useTranslations } from "@/lib/locale";


export function WorkspacesView({ onChanged, onOpen }: { onChanged(): void; onOpen(id: string): void }) {
  const t = useTranslations("workspacesView");
  async function request<T>(method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch("/api/workspaces", { method, signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? t("operationFailed"));
    return value;
  }
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
      {!settings ? <p className="text-sm text-muted-foreground">{error ? t("retryHint") : t("loadingWorkspaces")}</p> : <>
        <Card>
          <CardHeader><CardTitle><h2 className="text-base font-semibold">{t("defaultRootTitle")}</h2></CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={event => {
              event.preventDefault();
              void mutate("root", () => request("PUT", { workspaceRoot }), t("rootSavedNotice"));
            }}>
              <Label htmlFor="workspace-root">{t("parentDirLabel")}</Label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input id="workspace-root" value={workspaceRoot} required aria-describedby="workspace-root-hint"
                  onChange={event => setWorkspaceRoot(event.target.value)} placeholder={t("rootPlaceholder")} />
                <Button type="submit" disabled={!!pending}>{pending === "root" ? t("saving") : t("save")}</Button>
              </div>
              <p id="workspace-root-hint" className="text-xs leading-relaxed text-muted-foreground">{t("rootHint")}</p>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle><h2 className="text-base font-semibold">{t("registeredTitle")}</h2></CardTitle></CardHeader>
          <CardContent className="grid gap-6">
            {settings.workspaces.length ? <ul className="divide-y divide-border">
              {settings.workspaces.map(entry => <li key={entry.id} className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <strong className="text-sm font-medium">{entry.name}</strong>
                    <Badge variant={entry.available ? "secondary" : "outline"}>{entry.available ? t("availableLabel") : t("unavailableLabel")}</Badge>
                  </div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{entry.workspace}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" size="sm" disabled={!!pending || !entry.available} onClick={() => onOpen(entry.id)}>{t("openLabel")}</Button>
                  <Button type="button" size="sm" variant="outline" disabled={!!pending} onClick={() => void mutate(entry.id, () => request("DELETE", { id: entry.id }), t("removedNotice"))}>{t("removeLabel")}</Button>
                </div>
              </li>)}
            </ul> : <p className="text-sm text-muted-foreground">{t("noWorkspaces")}</p>}
            <form className="grid gap-3 border-t pt-6" onSubmit={event => {
              event.preventDefault();
              void mutate("register", async () => {
                await request("POST", { action: "register", workspace: existingPath }); setExistingPath("");
              }, t("registeredNotice"));
            }}>
              <Label htmlFor="workspace-existing">{t("registerExistingLabel")}</Label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input id="workspace-existing" value={existingPath} required aria-describedby="workspace-existing-hint"
                  onChange={event => setExistingPath(event.target.value)} placeholder={t("existingPathPlaceholder")} />
                <Button type="submit" variant="secondary" disabled={!!pending}>{pending === "register" ? t("registering") : t("registerDir")}</Button>
              </div>
              <p id="workspace-existing-hint" className="text-xs leading-relaxed text-muted-foreground">{t("identityHint")}</p>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle><h2 className="text-base font-semibold">{t("createTitle")}</h2></CardTitle></CardHeader>
          <CardContent>
            <form className="grid gap-5" onSubmit={event => {
              event.preventDefault();
              void mutate("create", async () => {
                await request("POST", { action: "create", workspace: create }); setCreate({ name: "", driver: "cua" });
              }, t("createdNotice"));
            }}>
              <fieldset disabled={!!pending} className="grid min-w-0 gap-5 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="workspace-name">{t("nameLabel")}</Label>
                  <Input id="workspace-name" value={create.name} onChange={event => setField("name", event.target.value)} required maxLength={120} placeholder={t("experimentPlaceholder")} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="workspace-driver">{t("driverIdLabel")}</Label>
                  <Input id="workspace-driver" value={create.driver} onChange={event => setField("driver", event.target.value)} required list="workspace-drivers" />
                  <datalist id="workspace-drivers"><option value="cua" /><option value="mgba" /><option value="azahar" /><option value="ryubing" /></datalist>
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="workspace-target">{t("targetDirLabel")}</Label>
                  <Input id="workspace-target" value={create.workspace ?? ""} onChange={event => setField("workspace", event.target.value)} placeholder={`${settings.config.workspaceRoot}${t("targetDirSuffix")}`} />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="workspace-driver-package">{t("driverPackageLabel")}</Label>
                  <Input id="workspace-driver-package" value={create.driverPackage ?? ""} onChange={event => setField("driverPackage", event.target.value)}
                    aria-describedby="workspace-create-hint" placeholder={t("driverPackagePlaceholder")} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="workspace-game">{t("gamePathLabel")}</Label>
                  <Input id="workspace-game" value={create.game ?? ""} onChange={event => setField("game", event.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="workspace-cua-command">{t("cuaCommandLabel")}</Label>
                  <Input id="workspace-cua-command" value={create.cuaCommand ?? ""} onChange={event => setField("cuaCommand", event.target.value)} />
                </div>
              </fieldset>
              <p id="workspace-create-hint" className="text-xs leading-relaxed text-muted-foreground">{t("createHint")}</p>
              <Button type="submit" className="justify-self-start" disabled={!!pending}>{pending === "create" ? t("creating") : t("createWorkspace")}</Button>
            </form>
          </CardContent>
        </Card>
      </>}
    </div>
  );
}
