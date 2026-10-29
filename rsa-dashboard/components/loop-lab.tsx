"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, Settings2Icon } from "lucide-react";
import { useLocale, useTranslations } from "@/lib/locale";
import { isPlainNavigationClick } from "@/lib/dashboard-navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoopChart } from "./loop-chart";
import { OMP_LAYER_DEFS, PRESETS, RSA_LAYER_DEFS, defaultParams, simulate, type LoopConfig, type LoopEvent, type LoopParams } from "@/lib/loop-lab";
import { LOOP_PARAM_KEYS, PARAM_GROUPS, createLoopDraft, validateLoopDraft, validateLoopParams, type LoopDraft, type LoopParamError } from "@/lib/loop-params";
import "./loop-lab.css";

const fmt = (n: number) => n >= 10000 ? `${Number((n / 1000).toFixed(1))}k` : String(Math.round(n));
const fill = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), text);
type Session = { params: LoopParams; draft: LoopDraft; config: LoopConfig; selected: number; requestDraft: string };
// Written only by a client effect. This is tab memory, never server or durable workspace state.
let tabSession: Session | undefined;
function initialSession(): Session {
  const saved = typeof window === "undefined" ? undefined : tabSession;
  if (saved && validateLoopParams(saved.params).params && LOOP_PARAM_KEYS.every(key => typeof saved.draft[key] === "string")
    && RSA_LAYER_DEFS.every(({ key }) => typeof saved.config.rsa[key] === "boolean")
    && OMP_LAYER_DEFS.every(({ key }) => typeof saved.config.omp[key] === "boolean")) return saved;
  const params = defaultParams();
  return { params, draft: createLoopDraft(params), config: PRESETS[0]!.cfg, selected: 1, requestDraft: "1" };
}
const EVENT_ROLE_KEYS: Partial<Record<LoopEvent["ch"], string>> = {
  system: "roles.system", user: "roles.user", assistant: "roles.assistant", final: "roles.final", tool: "roles.tool",
  compact: "roles.compact", observe: "roles.observe", state: "roles.state", pruning: "roles.pruning", cont: "history.continuation",
};

function Anatomy({ config }: { config: LoopConfig }) {
  const t = useTranslations("loopLab");
  const node = (label: string, on: boolean, kind: "rsa" | "nat") => <span className={`loop-node ${on ? `${kind}-on` : "off"}`}>{label}</span>;
  const arrow = <span className="loop-arrow" aria-hidden="true">→</span>;
  return <div className="loop-anatomy">
    <div className="loop-arow"><span className="loop-gname">{t("anatomy.inner")}</span>
      {node(t("anatomy.promptPrep"), true, "nat")}{arrow}{node("① before_agent_start", config.rsa.ch1, "rsa")}{arrow}
      {node(`${t("anatomy.transform")} (${[config.omp.dateCwd && "date/cwd", config.omp.schemas && "schema"].filter(Boolean).join(" + ") || t("anatomy.none")})`, config.omp.dateCwd || config.omp.schemas, "nat")}{arrow}
      {node(t("anatomy.modelRequest"), true, "nat")}{arrow}{node(t("anatomy.toolBatch"), true, "nat")}{arrow}
      {node(t("anatomy.appendTools"), config.rsa.ch2, "rsa")}{arrow}
      {node(`${t("anatomy.turnEndCheck")} (pruning${config.omp.compaction ? " / compaction" : ""})`, config.omp.pruning || config.omp.compaction, "nat")}
      <span className="loop-arrow" aria-hidden="true">↻</span>{node("final", true, "nat")}
    </div>
    <div className="loop-arow"><span className="loop-gname">{t("anatomy.outer")}</span>{node("final", true, "nat")}{arrow}
      {node(t("anatomy.resendCont"), config.rsa.cont, "rsa")}{arrow}{node(t("anatomy.backToPrep"), config.rsa.cont, "rsa")}
    </div>
  </div>;
}

export function LoopLab({ navigate }: { navigate?: (patch: Record<string, string | null>) => void }) {
  const t = useTranslations("loopLab"), { locale } = useLocale(), id = useId();
  const [initial] = useState(initialSession);
  const [params, setParams] = useState(initial.params), [draft, setDraft] = useState(initial.draft);
  const [config, setConfig] = useState(initial.config), [selected, setSelected] = useState(initial.selected);
  const [requestDraft, setRequestDraft] = useState(initial.requestDraft);
  const [controlsOpen, setControlsOpen] = useState(false), [openGroups, setOpenGroups] = useState(new Set(["loop"]));
  const [message, setMessage] = useState("");
  const fields = useRef<Partial<Record<keyof LoopParams, HTMLInputElement | null>>>({});
  useEffect(() => { setControlsOpen(window.matchMedia("(min-width: 1101px)").matches); }, []);
  useEffect(() => { tabSession = { params, draft, config, selected, requestDraft }; }, [params, draft, config, selected, requestDraft]);

  const validation = useMemo(() => validateLoopDraft(draft), [draft]);
  const dirty = LOOP_PARAM_KEYS.some(key => draft[key] !== String(params[key]));
  const invalidKeys = LOOP_PARAM_KEYS.filter(key => validation.errors[key]);
  const results = useMemo(() => ({ main: simulate(params, config), all: PRESETS.map(preset => ({ preset, result: simulate(params, preset.cfg) })) }), [params, config]);
  const { main } = results;
  const count = main.series.length, current = Math.min(Math.max(1, selected), Math.max(1, count));
  const selectedPoint = main.series[current - 1];
  const activePreset = PRESETS.find(preset => JSON.stringify(preset.cfg) === JSON.stringify(config));
  const requestNumber = /^\d+$/.test(requestDraft) ? Number(requestDraft) : NaN;
  const requestInvalid = !!count && (!Number.isSafeInteger(requestNumber) || requestNumber < 1 || requestNumber > count);
  useEffect(() => { if (selected !== current) { setSelected(current); setRequestDraft(String(current)); } }, [selected, current]);
  const selectRequest = (next: number) => {
    const safe = Math.min(Math.max(1, Math.round(next)), Math.max(1, count));
    setSelected(safe); setRequestDraft(String(safe));
  };
  const applyPreset = (next: string) => {
    const preset = PRESETS.find(preset => preset.id === next);
    if (preset) setConfig(preset.cfg);
  };
  const setGroup = (key: string, open: boolean) => setOpenGroups(previous => {
    if (previous.has(key) === open) return previous;
    const next = new Set(previous); if (open) next.add(key); else next.delete(key); return next;
  });
  const focusField = (key: keyof LoopParams) => {
    const group = PARAM_GROUPS.find(group => group.items.some(item => item.key === key));
    setControlsOpen(true); if (group) setGroup(group.title, true);
    requestAnimationFrame(() => fields.current[key]?.focus());
  };
  const errorText = (error: LoopParamError) => fill(t(`validation.${error.code}`), { min: error.min ?? "", max: error.max ?? "" });
  const applyParams = () => {
    if (!validation.params) { if (invalidKeys[0]) focusField(invalidKeys[0]); return; }
    setParams(validation.params); setDraft(createLoopDraft(validation.params)); setMessage("appliedStatus");
  };
  const resetParams = () => { const next = defaultParams(); setParams(next); setDraft(createLoopDraft(next)); setMessage("resetStatus"); };
  const peak = main.series.length ? main.series.reduce((best, point) => point.total > best.total ? point : best) : null;
  const frameShare = peak?.total ? Math.round((peak.ptext + peak.pimg) / peak.total * 100) : 0;
  const history = main.log.slice(-250), hiddenCount = main.log.length - history.length;
  const docs = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  docs.set("view", "docs"); docs.set("doc", "insights/omp-injection"); docs.set("docLang", locale); docs.delete("panel");
  const presetKind = (preset: string) => preset === "legacy" ? t("presetKindRemoved") : preset === "gate" ? t("presetKindHypothetical") : "";
  const comparisonKeys = ["requests", "peak", "frames", "compactions", "delivered", "retained"] as const;
  const primaryStats = [
    { key: "requests", label: t("stats.requests"), value: `${main.requests} / ${params.maxReq}` },
    { key: "peak", label: t("compare.peak"), value: fmt(main.peak) },
    { key: "frames", label: t("compare.frames"), value: String(main.frames) },
    { key: "compactions", label: t("compare.compactions"), value: String(main.compactions) },
  ];
  const breakdown = selectedPoint ? [
    { key: "sys", label: t("legend.sys"), value: selectedPoint.sys }, { key: "convo", label: t("legend.convo"), value: selectedPoint.convo },
    { key: "tools", label: t("legend.tools"), value: selectedPoint.tools }, { key: "ptext", label: t("legend.ptext"), value: selectedPoint.ptext },
    { key: "pimg", label: t("legend.pimg"), value: selectedPoint.pimg }, { key: "native", label: t("wire.decoLayer"), value: selectedPoint.deco },
  ] : [];

  return <section className="loop-lab" data-loop-lab>
    <Card className="loop-scenario shadow-none"><CardContent className="loop-scenario-content">
      <div className="loop-scenario-label"><Label htmlFor={`${id}-scenario`}>{t("scenario")}</Label><Badge variant="outline">{t("localOnly")}</Badge></div>
      <NativeSelect id={`${id}-scenario`} aria-label={t("scenario")} wrapperClassName="w-full sm:max-w-72" value={activePreset?.id ?? "custom"} onChange={event => applyPreset(event.target.value)}>
        {!activePreset && <NativeSelectOption value="custom" disabled>{t("custom")}</NativeSelectOption>}
        {PRESETS.map(preset => <NativeSelectOption key={preset.id} value={preset.id}>{t(`presetNames.${preset.id}.name`)}{presetKind(preset.id) && ` · ${presetKind(preset.id)}`}</NativeSelectOption>)}
      </NativeSelect>
      <p className="loop-scenario-description" data-loop-current-scenario={activePreset?.id ?? "custom"}>{activePreset ? t(`presetNames.${activePreset.id}.desc`) : t("customDescription")}</p>
    </CardContent></Card>
    <div className="loop-layout">
      <details className="loop-controls" open={controlsOpen} onToggle={event => { const next = event.currentTarget.open; setControlsOpen(previous => previous === next ? previous : next); }} data-loop-controls>
        <summary><Settings2Icon aria-hidden="true" /><span><strong>{t("controlsTitle")}</strong><small>{t("controlsDescription")}</small></span><ChevronDownIcon className="loop-disclosure-icon" aria-hidden="true" /></summary>
        <form className="loop-controls-body" data-loop-parameter-form noValidate onSubmit={event => { event.preventDefault(); applyParams(); }}>
          <div className="loop-param-actions"><Button type="submit" size="sm">{t("apply")}</Button><Button type="button" size="sm" variant="outline" onClick={resetParams}>{t("resetParams")}</Button></div>
          {dirty && <p className="loop-draft-notice" role="status" data-loop-draft-status>{t("unapplied")}</p>}
          {!dirty && message && <p className="loop-draft-notice" role="status">{t(message)}</p>}
          {invalidKeys.length > 0 && <Alert variant="destructive" data-loop-param-errors><AlertDescription><p>{t("errorSummary")}</p>
            <ul>{invalidKeys.map(key => <li key={key}><Button type="button" variant="link" className="h-auto whitespace-normal p-0 text-left text-xs" onClick={() => focusField(key)}>{t(`params.${key}`)}: {errorText(validation.errors[key]!)}</Button></li>)}</ul>
          </AlertDescription></Alert>}
          {PARAM_GROUPS.map(group => <details className="loop-control-group" key={group.title} open={openGroups.has(group.title)} onToggle={event => setGroup(group.title, event.currentTarget.open)} data-loop-param-group={group.title}>
            <summary><strong>{t(`groups.${group.title}`)}</strong><ChevronDownIcon className="loop-disclosure-icon" aria-hidden="true" /></summary>
            <div className="loop-fields">{group.items.map(item => {
              const error = validation.errors[item.key], fieldId = `${id}-${item.key}`;
              return <div className="loop-param" key={item.key}>
                <Label htmlFor={fieldId}>{t(`params.${item.key}`)}</Label>
                <div className="loop-param-value"><Input id={fieldId} name={item.key} data-loop-param={item.key} ref={element => { fields.current[item.key] = element; }}
                  type="text" inputMode={item.integer ? "numeric" : "decimal"} autoComplete="off" className="h-9 min-w-0 px-2 text-right font-mono text-xs"
                  value={draft[item.key]} aria-invalid={!!error} aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ""}`}
                  onChange={event => { setDraft(previous => ({ ...previous, [item.key]: event.target.value })); setMessage(""); }} />
                  <span>{t(`units.${item.key}`)}</span></div>
                <small id={`${fieldId}-hint`}>{item.min}–{item.max}{item.key === "imgCap" && <> · {t("imageCapInactive")}</>}</small>
                {error && <p id={`${fieldId}-error`} className="loop-field-error">{errorText(error)}</p>}
              </div>;
            })}</div>
          </details>)}
          <p className="loop-layers-notice">{t("layersImmediate")}</p>
          <details className="loop-control-group" data-loop-layer-group="rsa"><summary><strong>{t("rsaTitle")}</strong><ChevronDownIcon className="loop-disclosure-icon" aria-hidden="true" /></summary><div className="loop-layer-list">
            {RSA_LAYER_DEFS.map(layer => <Label key={layer.key} htmlFor={`${id}-rsa-${layer.key}`} className="loop-layer items-start font-normal">
              <Checkbox id={`${id}-rsa-${layer.key}`} data-loop-layer={`rsa.${layer.key}`} checked={config.rsa[layer.key]} onCheckedChange={checked => setConfig(previous => ({ ...previous, rsa: { ...previous.rsa, [layer.key]: checked === true } }))} />
              <span><b>{t(`rsaLayers.${layer.key}.name`)}</b><small>{t(`rsaLayers.${layer.key}.desc`)}</small></span>
            </Label>)}
          </div></details>
          <details className="loop-control-group" data-loop-layer-group="omp"><summary><strong>{t("ompTitle")}</strong><ChevronDownIcon className="loop-disclosure-icon" aria-hidden="true" /></summary><div className="loop-layer-list">
            {OMP_LAYER_DEFS.map(layer => <Label key={layer.key} htmlFor={`${id}-omp-${layer.key}`} className="loop-layer items-start font-normal">
              <Checkbox id={`${id}-omp-${layer.key}`} data-loop-layer={`omp.${layer.key}`} checked={config.omp[layer.key]} onCheckedChange={checked => setConfig(previous => ({ ...previous, omp: { ...previous.omp, [layer.key]: checked === true } }))} />
              <span><b>{t(`ompLayers.${layer.key}.name`)}</b><small>{t(`ompLayers.${layer.key}.desc`)}</small></span>
            </Label>)}
          </div></details>
        </form>
      </details>
      <div className="loop-results" data-loop-results>
        <Card className="shadow-none"><CardContent className="space-y-3"><h2 className="loop-section-title">{t("resultsTitle")}</h2>
          {dirty && <p className="loop-results-draft">{t("unapplied")}</p>}
          <div className="loop-stats">{primaryStats.map(stat => <div key={stat.key} className="loop-stat" data-loop-stat={stat.key}><span>{stat.label}</span><strong>{stat.value}</strong><small>{t("estimate")}</small></div>)}</div>
          <details className="loop-extra-metrics"><summary>{t("moreMetrics")}</summary><dl>
            <div><dt>{t("compare.delivered")}</dt><dd data-loop-metric="delivered">{main.frameTok}</dd></div><div><dt>{t("compare.retained")}</dt><dd data-loop-metric="retained">{main.retainedPerceptionTok}</dd></div>
            <div><dt>{t("stats.rounds")}</dt><dd>{main.rounds}</dd></div><div><dt>{t("stats.frameShare")}</dt><dd>{frameShare}%</dd></div><div><dt>{t("stats.decoPerReq")}</dt><dd>{main.decoTok}</dd></div>
          </dl></details>
        </CardContent></Card>
        <Card className="shadow-none"><CardContent className="space-y-3"><div><h2 className="loop-section-title">{t("chartTitle")}</h2><p className="loop-section-description">{t("chartDescription")}</p></div>
          <LoopChart series={main.series} thresh={params.thresh} selected={current} onSelect={selectRequest} />
          <div className="loop-legend">{(["sys", "convo", "tools", "ptext", "pimg", "total"] as const).map(key => <span key={key}><i aria-hidden="true" style={{ background: `var(--loop-${key === "total" ? "native" : key})` }} />{t(`legend.${key}`)}</span>)}</div>
          <Slider aria-label={t("inspector.request")} min={1} max={Math.max(2, count)} step={1} disabled={count <= 1} value={[current]} onValueChange={values => selectRequest(values[0] ?? 1)} />
          <form className="loop-request-controls" noValidate onSubmit={event => { event.preventDefault(); if (!requestInvalid && count) selectRequest(requestNumber); }}>
            <Button type="button" size="sm" variant="outline" aria-label={t("previousRequest")} aria-disabled={!count || current <= 1} className="aria-disabled:opacity-50" onClick={() => { if (current > 1) selectRequest(current - 1); }}><ArrowLeftIcon aria-hidden="true" /></Button>
            <div className="loop-request-entry"><Label htmlFor={`${id}-request`}>{t("inspector.request")}</Label><Input id={`${id}-request`} data-loop-request-input type="text" inputMode="numeric" className="h-8 w-16 text-right font-mono" value={count ? requestDraft : ""} disabled={!count} aria-invalid={requestInvalid} aria-describedby={requestInvalid ? `${id}-request-error` : undefined} onChange={event => setRequestDraft(event.target.value)} /><span>{fill(t("requestRange"), { count })}</span><Button type="submit" variant="ghost" size="sm" disabled={!count}>{t("goRequest")}</Button></div>
            <Button type="button" size="sm" variant="outline" aria-label={t("nextRequest")} aria-disabled={!count || current >= count} className="aria-disabled:opacity-50" onClick={() => { if (current < count) selectRequest(current + 1); }}><ArrowRightIcon aria-hidden="true" /></Button>
          </form>
          {requestInvalid && <p id={`${id}-request-error`} className="loop-field-error" role="status">{fill(t("requestInvalid"), { count })}</p>}
        </CardContent></Card>
        <Card className="shadow-none"><CardContent><div className="loop-inspector-heading"><h2 className="loop-section-title">{t("inspectorTitle")}</h2>{selectedPoint && <Badge variant="outline">#{selectedPoint.request} · {selectedPoint.total} tok</Badge>}{selectedPoint?.compacted && <Badge variant="outline">{t("chart.compactedBefore")}</Badge>}</div>
          {selectedPoint ? <dl className="loop-breakdown" data-loop-inspector-request={selectedPoint.request}>{breakdown.map(row => <div key={row.key}><dt><i aria-hidden="true" style={{ background: `var(--loop-${row.key})` }} />{row.label}</dt><dd data-loop-breakdown={row.key}>{row.value}<small>{selectedPoint.total ? Math.round(row.value / selectedPoint.total * 100) : 0}%</small></dd></div>)}</dl> : <p className="loop-section-description">{t("wire.empty")}</p>}
        </CardContent></Card>
        <Card className="shadow-none"><CardContent><h2 className="loop-section-title">{t("comparisonTitle")}</h2><p className="loop-section-description">{t("comparisonHint")}</p>
          <div className="loop-comparison-table"><Table className="loop-comparison"><TableHeader><TableRow><TableHead className="whitespace-normal">{t("compare.scenario")}</TableHead><TableHead className="whitespace-normal">{t("compare.requests")}</TableHead><TableHead className="whitespace-normal">{t("compare.peak")}</TableHead><TableHead className="whitespace-normal">{t("compare.frames")}</TableHead><TableHead className="whitespace-normal">{t("compare.compactions")}</TableHead><TableHead className="whitespace-normal">{t("compare.delivered")}</TableHead><TableHead className="whitespace-normal">{t("compare.retained")}</TableHead></TableRow></TableHeader>
            <TableBody>{results.all.map(({ preset, result }) => <TableRow key={preset.id} data-loop-compare={preset.id} data-state={activePreset?.id === preset.id ? "selected" : undefined}>
              <TableCell><Button type="button" variant="ghost" size="sm" className="h-auto flex-col items-start whitespace-normal text-left" aria-pressed={activePreset?.id === preset.id} onClick={() => applyPreset(preset.id)}>{t(`presetNames.${preset.id}.name`)}{presetKind(preset.id) && <small className="loop-preset-kind">{presetKind(preset.id)}</small>}</Button></TableCell>
              {[result.requests, result.peak, result.frames, result.compactions, result.frameTok, result.retainedPerceptionTok].map((value, index) => <TableCell className="font-mono text-xs tabular-nums" key={index}>{value}</TableCell>)}
            </TableRow>)}</TableBody>
          </Table></div>
          <div className="loop-comparison-mobile">{results.all.map(({ preset, result }) => <div key={preset.id} className="loop-comparison-card" data-loop-compare-mobile={preset.id} data-state={activePreset?.id === preset.id ? "selected" : undefined}>
            <Button type="button" variant="ghost" size="sm" className="h-auto flex-col items-start whitespace-normal p-0 text-left" aria-pressed={activePreset?.id === preset.id} onClick={() => applyPreset(preset.id)}>{t(`presetNames.${preset.id}.name`)}{presetKind(preset.id) && <small className="loop-preset-kind">{presetKind(preset.id)}</small>}</Button>
            <dl>{[result.requests, result.peak, result.frames, result.compactions, result.frameTok, result.retainedPerceptionTok].map((value, index) => <div key={comparisonKeys[index]}><dt>{t(`compare.${comparisonKeys[index]}`)}</dt><dd>{value}</dd></div>)}</dl>
          </div>)}</div>
        </CardContent></Card>
        <details className="loop-secondary"><summary><div><strong>{t("anatomyTitle")}</strong><small>{t("anatomyHint")}</small></div><ChevronDownIcon className="loop-disclosure-icon" aria-hidden="true" /></summary><Anatomy config={config} /></details>
        <details className="loop-secondary"><summary><div><strong>{t("historyTitle")}</strong><small>{t("historyHint")}</small></div><ChevronDownIcon className="loop-disclosure-icon" aria-hidden="true" /></summary><div className="loop-history">
          {hiddenCount > 0 && <p className="loop-hidden">{hiddenCount} {t("history.hiddenSuffix")}</p>}{history.map((event, index) => <HistoryRow key={index} event={event} />)}
        </div></details>
      </div>
    </div>
    <p className="loop-foot">{t("simulationFoot")} <a href={`/?${docs}`} onClick={event => { if (navigate && isPlainNavigationClick(event)) { event.preventDefault(); navigate({ view: "docs", doc: "insights/omp-injection", docLang: locale, panel: null }); } }}>{t("mechanismDocs")}</a></p>
  </section>;
}

function HistoryRow({ event }: { event: LoopEvent }) {
  const t = useTranslations("loopLab");
  const role = event.ch === "prompt_start" ? t("history.promptStart") : event.ch === "tool_batch" ? t("history.toolBatch") : t(EVENT_ROLE_KEYS[event.ch] ?? event.ch);
  const badge = event.changed === true ? t("history.changed") : event.changed === false ? t("history.unchanged") : "";
  return <div className={`loop-msg ${event.ch === "prompt_start" ? "pstart" : event.ch === "tool_batch" ? "pbatch" : "system"}`}>
    <span className={`loop-src ${event.omp ? "omp" : "rsa"}`}>{event.omp ? "OMP" : "RSA"}</span><span className="loop-role">{role}{badge && <i>{badge}</i>}</span>
    <span className="loop-tok">{event.tok !== 0 ? `${event.tok > 0 ? "+" : "−"}${fmt(Math.abs(event.tok))} tok · ` : ""}{Math.round(event.t)}s</span>
  </div>;
}
