"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import en from "@/messages/en.json";
import zh from "@/messages/zh.json";

export type Locale = "en" | "zh";
const dictionaries = { en, zh } as const;
type Dictionary = typeof en;
const STORAGE_KEY = "ludens-locale";

function browserLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function lookup(dict: Dictionary, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in node) node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof node === "string" ? node : undefined;
}

const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void; t: (key: string) => string }>({
  locale: "en",
  setLocale: () => {},
  t: key => key,
});

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored === "zh" || stored === "en" ? stored : browserLocale();
    } catch { return browserLocale(); }
  });
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
  }, []);
  const t = useCallback((key: string) => lookup(dictionaries[locale], key) ?? lookup(en, key) ?? key, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() { return useContext(LocaleContext); }
export function useTranslations(namespace: string) {
  const { t } = useLocale();
  return useCallback((key: string) => t(`${namespace}.${key}`), [t, namespace]);
}
