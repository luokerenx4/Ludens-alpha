"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CheckIcon, ChevronRightIcon, FolderIcon, LoaderCircleIcon, MonitorIcon, PlugIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useTranslations } from "@/lib/locale";
import type { DiscoveredDriver } from "@/lib/drivers";
import type { CreateWorkspaceInput } from "@/lib/workspaces";
import {
  initialWorkspaceSetup, switchWorkspaceEnvironment, workspaceCreateInput, workspaceDriverCapabilities,
  workspaceLocation, type WorkspaceCreationIntent, type WorkspaceEnvironment, type WorkspaceSetupIssue,
} from "./workspace-create-model";

export function WorkspaceCreateForm({ defaultRoot, initialIntent, pending, error, onSubmit, onCancel }: {
  defaultRoot: string;
  initialIntent?: WorkspaceCreationIntent | null;
  pending: boolean;
  error: string;
  onSubmit(input: CreateWorkspaceInput): void;
  onCancel(): void;
}) {
  const t = useTranslations("workspaceSetup");
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const request = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState(() => initialWorkspaceSetup(initialIntent).draft);
  const [driver, setDriver] = useState<DiscoveredDriver | null>(() => initialWorkspaceSetup(initialIntent).driver);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [issue, setIssue] = useState<WorkspaceSetupIssue | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const location = workspaceLocation(defaultRoot, draft);
  const capabilities = workspaceDriverCapabilities(draft.environment, driver);
  const community = draft.environment === "community";
  const verified = !!driver && driver.spec === draft.driverPackage.trim();
  const locationPreview = !location.path ? t("invalidDirectory")
    : !location.custom && !draft.name.trim() ? `${location.path.replace(/\/$/, "")}/${t("folderPlaceholder")}`
    : location.path;

  useEffect(() => () => {
    const active = request.current; request.current = null;
    active?.abort();
  }, []);
  const resetDiscovery = () => {
    const active = request.current; request.current = null;
    active?.abort();
    setDriver(null); setDiscovering(false); setDiscoveryError(""); setIssue(null);
  };
  const chooseEnvironment = (environment: WorkspaceEnvironment) => {
    if (draft.environment === environment) return;
    resetDiscovery();
    setDraft(previous => switchWorkspaceEnvironment(previous, environment));
  };
  const discover = async () => {
    const spec = draft.driverPackage.trim();
    if (!spec || pending || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setDiscovering(true); setDiscoveryError(""); setDriver(null); setIssue(null);
    try {
      const response = await fetch("/api/drivers/discover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }), signal: controller.signal,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? t("verificationFailed"));
      if (!controller.signal.aborted) setDriver(value as DiscoveredDriver);
    } catch (error) {
      if (!controller.signal.aborted) setDiscoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) { request.current = null; setDiscovering(false); }
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || discovering) return;
    const result = workspaceCreateInput(defaultRoot, draft, driver);
    if (!result.ok) {
      setIssue(result.issue);
      if (result.issue.field === "targetDirectory") setAdvanced(true);
      requestAnimationFrame(() => (form.current?.elements.namedItem(result.issue.field) as HTMLInputElement | null)?.focus());
      return;
    }
    setIssue(null); onSubmit(result.input);
  };
  const changeField = (field: "name" | "targetDirectory" | "game" | "cuaCommand", value: string) => {
    setIssue(null); setDraft(previous => ({ ...previous, [field]: value }));
  };

  return <form ref={form} onSubmit={submit} noValidate className="grid min-w-0 gap-5" aria-busy={pending || discovering}>
    <fieldset disabled={pending} className="grid min-w-0 gap-5">
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>{t("folderName")}</Label>
        <Input id={`${id}-name`} name="name" value={location.custom ? location.name : draft.name}
          readOnly={location.custom} aria-readonly={location.custom} required maxLength={120}
          placeholder={t("namePlaceholder")} aria-invalid={issue?.field === "name"}
          aria-describedby={location.custom ? `${id}-name-hint` : issue?.field === "name" ? `${id}-name-error` : undefined}
          onChange={event => changeField("name", event.target.value)} />
        {location.custom ? <p id={`${id}-name-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("nameFromDirectory")}</p> : null}
        {issue?.field === "name" ? <p id={`${id}-name-error`} role="alert" className="text-xs text-destructive">{t(issue.message)}</p> : null}
      </div>

      <div className="grid gap-2.5">
        <Label id={`${id}-environment`}>{t("connectTo")}</Label>
        <RadioGroup value={draft.environment} onValueChange={value => chooseEnvironment(value as WorkspaceEnvironment)}
          disabled={pending} aria-labelledby={`${id}-environment`} aria-describedby={`${id}-environment-hint`}
          className="grid grid-cols-2 gap-3">
          {(["desktop", "community"] as const).map(environment => {
            const Icon = environment === "desktop" ? MonitorIcon : PlugIcon;
            return <Label key={environment} htmlFor={`${id}-${environment}`}
              className={`flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border p-3.5 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 ${draft.environment === environment ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50"} ${pending ? "pointer-events-none opacity-50" : ""}`}>
              <RadioGroupItem id={`${id}-${environment}`} value={environment} />
              <Icon className="hidden size-5 shrink-0 text-muted-foreground min-[420px]:block" aria-hidden="true" />
              <span className="min-w-0 leading-snug"><span className="block text-sm font-medium">{t(environment)}</span>
                <span className="mt-1 block text-xs font-normal text-muted-foreground">{t(`${environment}Subtitle`)}</span></span>
            </Label>;
          })}
        </RadioGroup>
        <p id={`${id}-environment-hint`} className="text-xs leading-relaxed text-muted-foreground">{t(community ? "communityHint" : "desktopHint")}</p>
      </div>

      {community ? <div className="grid gap-3 rounded-lg border bg-muted/20 p-3.5">
        <Label htmlFor={`${id}-package`}>{t("packageAddress")}</Label>
        <div className="flex flex-col gap-2 min-[420px]:flex-row">
          <Input id={`${id}-package`} name="driverPackage" value={draft.driverPackage} required maxLength={500}
            spellCheck={false} placeholder={t("packagePlaceholder")} aria-invalid={!!discoveryError || issue?.field === "driverPackage"}
            aria-describedby={`${id}-package-hint${discoveryError || issue?.field === "driverPackage" ? ` ${id}-package-error` : ""}`}
            onChange={event => {
              const driverPackage = event.target.value;
              resetDiscovery(); setDraft(previous => ({ ...previous, driverPackage, game: "", cuaCommand: "" }));
            }} />
          <Button type="button" variant="outline" aria-disabled={pending || discovering || !draft.driverPackage.trim()} className="aria-disabled:opacity-50" onClick={() => void discover()}>
            {discovering ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
            {t(discovering ? "verifying" : "verifyPackage")}
          </Button>
        </div>
        <p id={`${id}-package-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("packageHint")}</p>
        {discoveryError || issue?.field === "driverPackage" ? <p id={`${id}-package-error`} role="alert" className="break-words text-xs text-destructive">{discoveryError || (issue ? t(issue.message) : "")}</p> : null}
        {verified ? <div className="grid gap-2 border-t pt-3" role="status">
          <div className="flex flex-wrap items-center gap-2 text-sm"><CheckIcon className="size-4 text-success" aria-hidden="true" />
            <span>{t("driverVerified")}</span><Badge variant="outline">{driver.id}</Badge><span className="text-xs text-muted-foreground">{driver.version}</span>
          </div>
          {driver.launchHint ? <p className="break-words text-xs leading-relaxed text-muted-foreground">{driver.launchHint}</p> : null}
          {capabilities.missingPort ? <p className="text-xs text-destructive">{t("unsupportedBridge")}</p> : null}
        </div> : <p className="text-xs text-muted-foreground">{t("verifyFirstHint")}</p>}
      </div> : null}

      <div className="grid min-w-0 gap-2">
        <Label id={`${id}-location-label`}>{t("workspaceLocation")}</Label>
        <div className="flex min-w-0 items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-sm" aria-labelledby={`${id}-location-label`}>
          <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <output className="min-w-0 break-all font-mono text-xs leading-5">{locationPreview}</output>
        </div>
      </div>

      <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)} className="group min-w-0 rounded-lg border">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3.5 py-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />{t("advanced")}
        </summary>
        <div className="grid gap-4 border-t p-3.5">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-directory`}>{t("customDirectory")}</Label>
            <Input id={`${id}-directory`} name="targetDirectory" value={draft.targetDirectory} maxLength={2000}
              placeholder={t("directoryPlaceholder")} spellCheck={false} aria-invalid={issue?.field === "targetDirectory"}
              aria-describedby={`${id}-directory-hint${issue?.field === "targetDirectory" ? ` ${id}-directory-error` : ""}`}
              onChange={event => changeField("targetDirectory", event.target.value)} />
            <p id={`${id}-directory-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("directoryHint")}</p>
            {issue?.field === "targetDirectory" ? <p id={`${id}-directory-error`} role="alert" className="text-xs text-destructive">{t(issue.message)}</p> : null}
          </div>
          {capabilities.stdio ? <div className="grid gap-2">
            <Label htmlFor={`${id}-command`}>{t("executable")}</Label>
            <Input id={`${id}-command`} name="cuaCommand" value={draft.cuaCommand} maxLength={2000} spellCheck={false}
              placeholder={community ? t("executablePlaceholder") : "cua-driver"} aria-describedby={`${id}-command-hint`}
              onChange={event => changeField("cuaCommand", event.target.value)} />
            <p id={`${id}-command-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("executableHint")}</p>
          </div> : null}
          {capabilities.supportsGame ? <div className="grid gap-2">
            <Label htmlFor={`${id}-game`}>{t("gamePath")}</Label>
            <Input id={`${id}-game`} name="game" value={draft.game} maxLength={2000} spellCheck={false}
              placeholder={t("gamePlaceholder")} aria-describedby={`${id}-game-hint`}
              onChange={event => changeField("game", event.target.value)} />
            <p id={`${id}-game-hint`} className="text-xs leading-relaxed text-muted-foreground">{t("gameHint")}</p>
          </div> : null}
        </div>
      </details>
    </fieldset>

    {error ? <Alert variant="destructive"><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}
    <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs leading-relaxed text-muted-foreground" role={pending ? "status" : undefined}>{t(pending ? "creatingHint" : "createHint")}</p>
      <div className="flex shrink-0 justify-end gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => {
          const active = request.current; request.current = null;
          active?.abort(); onCancel();
        }}>{t("cancel")}</Button>
        <Button type="submit" disabled={pending || discovering || (community && (!verified || capabilities.missingPort))}>
          {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}{t(pending ? "creating" : "create")}
        </Button>
      </div>
    </div>
  </form>;
}
