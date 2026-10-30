"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/locale";
import { parseReplayElapsed, replayElapsedInput } from "./replay-navigation";

export function ReplayTimeJump({ elapsed, duration, onJump }: { elapsed: number; duration: number; onJump(elapsed: number): void }) {
  const t = useTranslations("replayNavigation");
  const id = useId();
  const elapsedInput = replayElapsedInput(elapsed, "milliseconds");
  const [draft, setDraft] = useState(elapsedInput);
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [clamped, setClamped] = useState(false);
  useEffect(() => { if (!dirty) setDraft(elapsedInput); }, [elapsedInput, dirty]);
  return <form className="replay-time-jump" onSubmit={event => {
    event.preventDefault();
    const target = parseReplayElapsed(draft);
    if (target === null) { setInvalid(true); setClamped(false); return; }
    const next = Math.min(duration, target);
    setInvalid(false); setClamped(target > duration); setDirty(false); setDraft(replayElapsedInput(next, "milliseconds")); onJump(next);
  }}>
    <Label htmlFor={id} className="text-xs">{t("jumpLabel")}</Label>
    <Input id={id} value={draft} aria-invalid={invalid} aria-describedby={`${id}-hint`} className="font-mono text-sm tabular-nums" spellCheck={false}
      onChange={event => { setDirty(true); setInvalid(false); setClamped(false); setDraft(event.target.value); }} />
    <Button type="submit" variant="outline" size="sm">{t("jump")}</Button>
    <span id={`${id}-hint`} className="replay-jump-hint text-xs text-muted-foreground" role={invalid || clamped ? "status" : undefined}>
      {invalid ? t("invalidTime") : clamped ? t("clampedTime").replace("{time}", replayElapsedInput(duration, "milliseconds")) : t("timeFormat")}
    </span>
  </form>;
}
